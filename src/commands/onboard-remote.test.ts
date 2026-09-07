// Onboard remote tests cover remote gateway prompts, Bonjour discovery, and remote config mutation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/auth-wizard.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { captureEnv } from "../test-utils/env.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";

const discoverGatewayBeacons = vi.hoisted(() => vi.fn<() => Promise<GatewayBonjourBeacon[]>>());
const resolveWideAreaDiscoveryDomain = vi.hoisted(() => vi.fn(() => undefined));
const detectBinary = vi.hoisted(() => vi.fn<(name: string) => Promise<boolean>>());
const INSECURE_WS_URL_MESSAGE =
  "Use wss:// for remote hosts, or ws://127.0.0.1/localhost via SSH tunnel. " +
  "Break-glass: OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 for trusted private networks.";

vi.mock("../infra/bonjour-discovery.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/bonjour-discovery.js")>(
    "../infra/bonjour-discovery.js",
  );
  return {
    ...actual,
    discoverGatewayBeacons,
  };
});

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain,
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBinary,
}));

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(overrides, { defaultSelect: "" });
}

function createSelectPrompter(
  responses: Partial<Record<string, string>>,
): WizardPrompter["select"] {
  return vi.fn(async (params) => {
    const value = responses[params.message];
    if (value !== undefined) {
      return value as never;
    }
    return (params.options[0]?.value ?? "") as never;
  });
}

function createGatewayDiscoveryBeacon(): GatewayBonjourBeacon {
  return {
    instanceName: "gateway",
    displayName: "Gateway",
    host: "gateway.tailnet.ts.net",
    port: 18789,
    gatewayTlsFingerprintSha256: "sha256:abc123",
  };
}

describe("promptRemoteGatewayConfig", () => {
  const envSnapshot = captureEnv(["OPENCLAW_ALLOW_INSECURE_PRIVATE_WS", "OPENCLAW_GATEWAY_TOKEN"]);

  async function runRemotePrompt(params: {
    cfg?: OpenClawConfig;
    text: WizardPrompter["text"];
    selectResponses: Partial<Record<string, string>>;
    confirm: boolean;
  }) {
    const cfg = params.cfg ?? {};
    const prompter = createPrompter({
      confirm: vi.fn(async () => params.confirm),
      select: createSelectPrompter(params.selectResponses),
      text: params.text,
    });
    const next = await promptRemoteGatewayConfig(cfg, prompter);
    return { next, prompter };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    detectBinary.mockResolvedValue(false);
    discoverGatewayBeacons.mockResolvedValue([]);
    resolveWideAreaDiscoveryDomain.mockReturnValue(undefined);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it.each([
    { name: "unchanged URL", auth: "token", url: "wss://gateway.example/rpc" },
    { name: "trimmed URL", auth: "token", url: " wss://gateway.example/rpc " },
    { name: "changed host", auth: "token", url: "wss://other.example/rpc" },
    { name: "changed path", auth: "token", url: "wss://gateway.example/other" },
    { name: "auth disabled", auth: "off", url: "wss://gateway.example/rpc" },
    {
      name: "changed URL seeded by onboarding",
      auth: "token",
      url: "wss://other.example/rpc",
      seededUrl: "wss://other.example/rpc",
    },
    {
      name: "seeded URL edited back to the original endpoint",
      auth: "token",
      url: "wss://gateway.example/rpc",
      seededUrl: "wss://other.example/rpc",
    },
    {
      name: "seeded URL without a previously configured endpoint",
      auth: "token",
      url: "wss://other.example/rpc",
      seededUrl: "wss://other.example/rpc",
      noOriginalUrl: true,
    },
  ])("scopes saved remote settings for $name", async ({ auth, url, seededUrl, noOriginalUrl }) => {
    const remote = {
      url: noOriginalUrl ? undefined : " wss://gateway.example/rpc ",
      transport: "direct" as const,
      remotePort: 19443,
      token: "existing-token",
      password: "existing-password",
      edgeAuth: { "X-Edge-Auth": "test-secret" },
      tlsFingerprint: "ab".repeat(32),
      sshTarget: "operator@gateway.example",
      sshIdentity: "/tmp/test-identity",
      sshHostKeyPolicy: "strict" as const,
    };
    const cfg: OpenClawConfig = {
      gateway: { mode: "remote", remote: { ...remote, url: seededUrl ?? remote.url } },
    };
    detectBinary.mockResolvedValue(true);
    const prompter = createPrompter({
      confirm: vi.fn(async ({ message }) => message === "Continue without a Gateway secret?"),
      select: createSelectPrompter({}),
      text: vi.fn(async ({ message }) =>
        message === "Gateway WebSocket URL" ? url : auth === "token" ? "entered-secret" : "",
      ),
    });

    const next = await promptRemoteGatewayConfig(cfg, prompter, {
      secretInputMode: "plaintext",
      ...(seededUrl ? { remoteOriginUrl: remote.url } : {}),
    });

    const unchanged = url.trim() === remote.url?.trim();
    expect(next.gateway?.remote).toEqual({
      ...(unchanged ? remote : {}),
      url: url.trim(),
      token: auth === "token" ? "entered-secret" : undefined,
      password: undefined,
    });
    expect(cfg.gateway?.remote).toEqual({ ...remote, url: seededUrl ?? remote.url });
    expect(discoverGatewayBeacons).not.toHaveBeenCalled();
  });

  it.each([
    ["preserves", "wss://gateway.example/rpc", { "X-Edge-Auth": "test-secret" }],
    ["clears", "wss://other.example/rpc", undefined],
  ])("%s edge auth based on the remote Gateway scope", async (_label, nextUrl, expected) => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example/rpc/",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    };
    const prompter = createPrompter({
      confirm: vi.fn(async ({ message }) => message === "Continue without a Gateway secret?"),
      select: createSelectPrompter({}),
      text: vi.fn(async (params) =>
        params.message === "Gateway WebSocket URL" ? nextUrl : "",
      ) as WizardPrompter["text"],
    });

    const next = await promptRemoteGatewayConfig(cfg, prompter);

    expect(next.gateway?.remote?.edgeAuth).toEqual(expected);
  });

  it.each([undefined, "wss://gateway.tailnet.ts.net:18789", "wss://old.example/rpc"])(
    "pins a trusted discovery endpoint with previous URL %s",
    async (previousUrl) => {
      detectBinary.mockResolvedValue(true);
      discoverGatewayBeacons.mockResolvedValue([createGatewayDiscoveryBeacon()]);

      const text: WizardPrompter["text"] = vi.fn(async (params) => {
        if (params.message === "Gateway WebSocket URL") {
          expect(params.initialValue).toBe("wss://gateway.tailnet.ts.net:18789");
          expect(params.validate?.(String(params.initialValue))).toBeUndefined();
          return String(params.initialValue);
        }
        if (params.message === "Gateway secret") {
          return "token-123";
        }
        return "";
      }) as WizardPrompter["text"];

      const { next, prompter } = await runRemotePrompt({
        cfg: {
          gateway: {
            remote: {
              url: previousUrl,
              transport: "ssh",
              sshTarget: "operator@old.example",
              tlsFingerprint: "sha256:old-pin",
            },
          },
        },
        text,
        confirm: true,
        selectResponses: {
          "Select gateway": "0",
          "Connection method": "direct",
        },
      });

      expect(next.gateway?.mode).toBe("remote");
      expect(next.gateway?.remote?.url).toBe("wss://gateway.tailnet.ts.net:18789");
      expect(next.gateway?.remote?.transport).toBe("direct");
      expect(next.gateway?.remote?.token).toBe("token-123");
      expect(next.gateway?.remote?.tlsFingerprint).toBe("sha256:abc123");
      expect(prompter.note).toHaveBeenCalledWith(
        [
          "Direct remote access defaults to TLS.",
          "Using: wss://gateway.tailnet.ts.net:18789",
          "TLS pin: sha256:abc123",
          "If your gateway is loopback-only, choose SSH tunnel and keep ws://127.0.0.1:18789.",
        ].join("\n"),
        "Direct remote",
      );
    },
  );

  it("does not retain a saved SSH route when discovery suggests a new manual tunnel", async () => {
    detectBinary.mockResolvedValue(true);
    discoverGatewayBeacons.mockResolvedValue([createGatewayDiscoveryBeacon()]);
    const { next, prompter } = await runRemotePrompt({
      cfg: {
        gateway: {
          remote: {
            url: "ws://127.0.0.1:18789",
            transport: "ssh",
            sshTarget: "operator@old.example",
            sshIdentity: "/tmp/old-identity",
            sshHostKeyPolicy: "openssh",
            remotePort: 19443,
            token: "old-tunnel-secret",
          },
        },
      },
      text: vi.fn(async (params) =>
        params.message === "Gateway WebSocket URL" ? String(params.initialValue) : "",
      ),
      confirm: true,
      selectResponses: {
        "Select gateway": "0",
        "Connection method": "ssh",
      },
    });

    expect(next.gateway?.remote).toEqual({ url: "ws://127.0.0.1:18789" });
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("<user>@gateway.tailnet.ts.net"),
      "SSH tunnel",
    );
  });

  it("falls back to manual URL entry when discovery trust is declined", async () => {
    detectBinary.mockResolvedValue(true);
    discoverGatewayBeacons.mockResolvedValue([
      {
        instanceName: "evil",
        displayName: "Evil",
        host: "evil.example",
        port: 443,
        gatewayTlsFingerprintSha256: "sha256:attacker",
      },
    ]);

    const select = createSelectPrompter({
      "Select gateway": "0",
      "Connection method": "direct",
    });
    const manualUrl = "wss://manual.example.com:18789";
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        expect(params.initialValue).toBe("ws://127.0.0.1:18789");
        return manualUrl;
      }
      return "";
    }) as WizardPrompter["text"];
    const confirm: WizardPrompter["confirm"] = vi.fn(async (params) => {
      if (params.message.startsWith("Discover gateway")) {
        return true;
      }
      if (params.message.startsWith("Trust this gateway")) {
        return false;
      }
      return params.message === "Continue without a Gateway secret?";
    });

    const prompter = createPrompter({
      confirm,
      select,
      text,
    });

    const next = await promptRemoteGatewayConfig({} as OpenClawConfig, prompter);

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe(manualUrl);
    expect(next.gateway?.remote?.tlsFingerprint).toBeUndefined();
  });

  it.each([undefined, "sha256:existing-pin"])(
    "trusts discovery without an advertised fingerprint and retains existing pin %s",
    async (tlsFingerprint) => {
      detectBinary.mockResolvedValue(true);
      discoverGatewayBeacons.mockResolvedValue([
        {
          instanceName: "gw",
          displayName: "Gateway",
          host: "gw.example",
          port: 18789,
        },
      ]);

      const text: WizardPrompter["text"] = vi.fn(async (params) => {
        if (params.message === "Gateway WebSocket URL") {
          return String(params.initialValue);
        }
        return "";
      }) as WizardPrompter["text"];

      const { next } = await runRemotePrompt({
        cfg: { gateway: { remote: { url: "wss://gw.example:18789", tlsFingerprint } } },
        text,
        confirm: true,
        selectResponses: {
          "Select gateway": "0",
          "Connection method": "direct",
        },
      });

      expect(next.gateway?.remote?.url).toBe("wss://gw.example:18789");
      expect(next.gateway?.remote?.tlsFingerprint).toBe(tlsFingerprint);
    },
  );

  it.each([undefined, "wss://old.example:443", "wss://other.example:443"])(
    "scopes discovery and saved pins after URL edits with previous URL %s",
    async (previousUrl) => {
      detectBinary.mockResolvedValue(true);
      discoverGatewayBeacons.mockResolvedValue([createGatewayDiscoveryBeacon()]);

      const text: WizardPrompter["text"] = vi.fn(async (params) => {
        if (params.message === "Gateway WebSocket URL") {
          return "wss://other.example:443";
        }
        return "";
      }) as WizardPrompter["text"];

      const { next } = await runRemotePrompt({
        cfg: { gateway: { remote: { url: previousUrl, tlsFingerprint: "sha256:old-pin" } } },
        text,
        confirm: true,
        selectResponses: {
          "Select gateway": "0",
          "Connection method": "direct",
        },
      });

      expect(next.gateway?.remote?.url).toBe("wss://other.example:443");
      expect(next.gateway?.remote?.tlsFingerprint).toBe(
        previousUrl === "wss://other.example:443" ? "sha256:old-pin" : undefined,
      );
    },
  );

  it("does not route from TXT-only discovery metadata", async () => {
    detectBinary.mockResolvedValue(true);
    discoverGatewayBeacons.mockResolvedValue([
      {
        instanceName: "gateway",
        displayName: "Gateway",
        lanHost: "attacker.example.com",
        tailnetDns: "attacker.tailnet.ts.net",
        gatewayPort: 19443,
        sshPort: 2222,
      },
    ]);

    const select: WizardPrompter["select"] = vi.fn(async (params) => {
      if (params.message === "Select gateway") {
        return "0" as never;
      }
      return (params.options[0]?.value ?? "") as never;
    });
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        expect(params.initialValue).toBe("ws://127.0.0.1:18789");
        return String(params.initialValue);
      }
      return "";
    }) as WizardPrompter["text"];
    const prompter = createPrompter({
      confirm: vi.fn(async () => true),
      select,
      text,
    });

    const next = await promptRemoteGatewayConfig({} as OpenClawConfig, prompter);

    expect(next.gateway?.remote?.url).toBe("ws://127.0.0.1:18789");
    expect(vi.mocked(select).mock.calls.map(([params]) => params.message)).not.toContain(
      "Connection method",
    );
  });

  it("validates insecure ws:// remote URLs and allows trusted private ws:// by default", async () => {
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        // ws:// to public IPs is rejected
        expect(params.validate?.("ws://203.0.113.10:18789")).toBe(INSECURE_WS_URL_MESSAGE);
        // ws:// to trusted LAN/Tailnet endpoints is accepted.
        expect(params.validate?.("ws://10.0.0.8:18789")).toBeUndefined();
        expect(params.validate?.("ws://127.0.0.1:18789")).toBeUndefined();
        expect(params.validate?.("wss://remote.example.com:18789")).toBeUndefined();
        return "wss://remote.example.com:18789";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next } = await runRemotePrompt({
      text,
      confirm: true,
      selectResponses: {},
    });

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("wss://remote.example.com:18789");
    expect(next.gateway?.remote?.token).toBeUndefined();
  });

  it("allows ws:// hostname remote URLs when OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", async () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        expect(params.validate?.("ws://openclaw-gateway.ai:18789")).toBeUndefined();
        expect(params.validate?.("ws://1.1.1.1:18789")).toBe(INSECURE_WS_URL_MESSAGE);
        return "ws://openclaw-gateway.ai:18789";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next } = await runRemotePrompt({
      text,
      confirm: true,
      selectResponses: {},
    });

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("ws://openclaw-gateway.ai:18789");
  });

  it("allows explicit no-auth confirmation even when reference storage is selected", async () => {
    const prompter = createPrompter({
      text: vi.fn(async () => "wss://remote.example.com:18789"),
      confirm: vi.fn(async () => true),
    });
    const next = await promptRemoteGatewayConfig(
      {
        gateway: { remote: { url: "wss://remote.example.com:18789", password: "saved-password" } },
      },
      prompter,
      { secretInputMode: "ref" },
    );
    expect(next.gateway?.remote?.token).toBeUndefined();
    expect(next.gateway?.remote?.password).toBeUndefined();
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Continue without a Gateway secret?",
      initialValue: false,
    });
    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("supports storing remote auth as an external env secret ref", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "remote-token-value";
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        return "wss://remote.example.com:18789";
      }
      if (params.message === "Environment variable name") {
        return "OPENCLAW_GATEWAY_TOKEN";
      }
      return "";
    }) as WizardPrompter["text"];

    const select: WizardPrompter["select"] = vi.fn(async (params) => {
      if (params.message === "How do you want to provide this Gateway secret?") {
        return "ref" as never;
      }
      if (params.message === "Where is this Gateway secret stored?") {
        return "env" as never;
      }
      return (params.options[0]?.value ?? "") as never;
    });

    const cfg = {} as OpenClawConfig;
    const prompter = createPrompter({
      confirm: vi.fn(async () => false),
      select,
      text,
    });

    const next = await promptRemoteGatewayConfig(cfg, prompter);

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("wss://remote.example.com:18789");
    expect(next.gateway?.remote?.token).toEqual({
      source: "env",
      provider: "default",
      id: "OPENCLAW_GATEWAY_TOKEN",
    });
  });

  it.each([
    { name: "a fresh config", remote: {} },
    { name: "an existing password", remote: { password: "old-password" } },
  ])("stores one sensitive Gateway secret as a token for $name", async ({ remote }) => {
    const text = vi.fn(async ({ message }: Parameters<WizardPrompter["text"]>[0]) =>
      message === "Gateway WebSocket URL" ? "wss://remote.example.com:18789" : "new-secret",
    );
    const { next, prompter } = await runRemotePrompt({
      cfg: { gateway: { remote } },
      text,
      confirm: false,
      selectResponses: {},
    });

    expect(next.gateway?.remote?.token).toBe("new-secret");
    expect(next.gateway?.remote?.password).toBeUndefined();
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Gateway secret",
        sensitive: true,
      }),
    );
    expect(vi.mocked(prompter.select).mock.calls.map(([params]) => params.message)).not.toContain(
      "Gateway auth",
    );
    expect(vi.mocked(text).mock.calls.map(([params]) => params.message)).toEqual([
      "Gateway WebSocket URL",
      "Gateway secret",
    ]);
  });

  it.each([
    { name: "plaintext token", remote: { token: "existing-token" }, expected: "existing-token" },
    {
      name: "plaintext password",
      remote: { password: "existing-password" },
      expected: "existing-password",
    },
    {
      name: "token SecretRef",
      remote: { token: { source: "env", provider: "default", id: "REMOTE_SECRET" } },
      expected: { source: "env", provider: "default", id: "REMOTE_SECRET" },
    },
    {
      name: "password SecretRef",
      remote: { password: { source: "env", provider: "default", id: "REMOTE_PASSWORD" } },
      expected: { source: "env", provider: "default", id: "REMOTE_PASSWORD" },
    },
  ] as const)(
    "keeps an existing $name as the remote token after blank input and confirmation",
    async ({ remote, expected }) => {
      const url = "wss://remote.example.com:18789";
      const text = vi.fn(async ({ message }: Parameters<WizardPrompter["text"]>[0]) =>
        message === "Gateway WebSocket URL" ? url : "",
      );
      const { next, prompter } = await runRemotePrompt({
        cfg: { gateway: { remote: { url, ...remote } } },
        text,
        confirm: true,
        selectResponses: {},
      });

      expect(next.gateway?.remote?.token).toEqual(expected);
      expect(next.gateway?.remote?.password).toBeUndefined();
      expect(prompter.confirm).toHaveBeenCalledExactlyOnceWith({
        message: "Keep the existing Gateway secret?",
        initialValue: true,
      });
      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Gateway secret", sensitive: true }),
      );
    },
  );

  it.each([
    { name: "a fresh endpoint", remote: {} },
    {
      name: "an existing credential the operator declines to keep",
      remote: { url: "wss://remote.example.com:18789", token: "old-secret" },
    },
    {
      name: "a changed endpoint",
      remote: { url: "wss://old.example.com:18789", token: "old-secret" },
    },
  ])("requires explicit confirmation for no auth with $name", async ({ remote }) => {
    const confirm = vi.fn(
      async ({ message }: Parameters<WizardPrompter["confirm"]>[0]) =>
        message === "Continue without a Gateway secret?",
    );
    const prompter = createPrompter({
      confirm,
      select: createSelectPrompter({}),
      text: vi.fn(async ({ message }) =>
        message === "Gateway WebSocket URL" ? "wss://remote.example.com:18789" : "",
      ),
    });
    const next = await promptRemoteGatewayConfig({ gateway: { remote } }, prompter);

    expect(next.gateway?.remote?.token).toBeUndefined();
    expect(next.gateway?.remote?.password).toBeUndefined();
    expect(confirm).toHaveBeenCalledWith({
      message: "Continue without a Gateway secret?",
      initialValue: false,
    });
    const confirmationMessages = confirm.mock.calls.map(([params]) => params.message);
    if (remote.url === "wss://remote.example.com:18789") {
      expect(confirmationMessages).toEqual([
        "Keep the existing Gateway secret?",
        "Continue without a Gateway secret?",
      ]);
    } else {
      expect(confirmationMessages).toEqual(["Continue without a Gateway secret?"]);
    }
  });

  it("asks for the secret again when the operator declines to continue without one", async () => {
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("wss://remote.example.com:18789")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("replacement-secret");
    const { next, prompter } = await runRemotePrompt({
      text,
      confirm: false,
      selectResponses: {},
    });

    expect(next.gateway?.remote?.token).toBe("replacement-secret");
    expect(prompter.confirm).toHaveBeenCalledExactlyOnceWith({
      message: "Continue without a Gateway secret?",
      initialValue: false,
    });
    expect(text.mock.calls.map(([params]) => params.message)).toEqual([
      "Gateway WebSocket URL",
      "Gateway secret",
      "Gateway secret",
    ]);
  });
});
