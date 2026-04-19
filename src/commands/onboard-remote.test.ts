import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { captureEnv } from "../test-utils/env.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { createWizardPrompter } from "./test-wizard-helpers.js";

const discoverGatewayBeacons = vi.hoisted(() => vi.fn<() => Promise<GatewayBonjourBeacon[]>>());
const resolveWideAreaDiscoveryDomain = vi.hoisted(() => vi.fn(() => undefined));
const detectBinary = vi.hoisted(() => vi.fn<(name: string) => Promise<boolean>>());

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
  const envSnapshot = captureEnv(["OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"]);

  async function runRemotePrompt(params: {
    text: WizardPrompter["text"];
    selectResponses: Partial<Record<string, string>>;
    confirm: boolean;
  }) {
    const cfg = {} as OpenClawConfig;
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
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
  });

  it("defaults discovered direct remote URLs to wss://", async () => {
    detectBinary.mockResolvedValue(true);
    discoverGatewayBeacons.mockResolvedValue([createGatewayDiscoveryBeacon()]);

    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        expect(params.initialValue).toBe("wss://gateway.tailnet.ts.net:18789");
        expect(params.validate?.(String(params.initialValue))).toBeUndefined();
        return String(params.initialValue);
      }
      if (params.message === "Gateway token") {
        return "token-123";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next, prompter } = await runRemotePrompt({
      text,
      confirm: true,
      selectResponses: {
        "Select gateway": "0",
        "Connection method": "direct",
        "Gateway auth": "token",
      },
    });

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("wss://gateway.tailnet.ts.net:18789");
    expect(next.gateway?.remote?.token).toBe("token-123");
    expect(next.gateway?.remote?.tlsFingerprint).toBe("sha256:abc123");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Direct remote access defaults to TLS."),
      "Direct remote",
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
      return false;
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

  it("trusts discovery endpoint without fingerprint and omits tlsFingerprint", async () => {
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
      text,
      confirm: true,
      selectResponses: {
        "Select gateway": "0",
        "Connection method": "direct",
        "Gateway auth": "off",
      },
    });

    expect(next.gateway?.remote?.url).toBe("wss://gw.example:18789");
    expect(next.gateway?.remote?.tlsFingerprint).toBeUndefined();
  });

  it("drops discovery tlsFingerprint when the URL is edited after trust confirmation", async () => {
    detectBinary.mockResolvedValue(true);
    discoverGatewayBeacons.mockResolvedValue([createGatewayDiscoveryBeacon()]);

    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        return "wss://other.example:443";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next } = await runRemotePrompt({
      text,
      confirm: true,
      selectResponses: {
        "Select gateway": "0",
        "Connection method": "direct",
        "Gateway auth": "off",
      },
    });

    expect(next.gateway?.remote?.url).toBe("wss://other.example:443");
    expect(next.gateway?.remote?.tlsFingerprint).toBeUndefined();
  });

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
      if (params.message === "Gateway auth") {
        return "off" as never;
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
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Connection method" }),
    );
  });

  it("validates insecure ws:// remote URLs and allows only loopback ws:// by default", async () => {
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        // ws:// to public IPs is rejected
        expect(params.validate?.("ws://203.0.113.10:18789")).toContain("Use wss://");
        // ws:// to private IPs remains blocked by default
        expect(params.validate?.("ws://10.0.0.8:18789")).toContain("Use wss://");
        expect(params.validate?.("ws://127.0.0.1:18789")).toBeUndefined();
        expect(params.validate?.("wss://remote.example.com:18789")).toBeUndefined();
        return "wss://remote.example.com:18789";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next } = await runRemotePrompt({
      text,
      confirm: false,
      selectResponses: { "Gateway auth": "off" },
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
        expect(params.validate?.("ws://1.1.1.1:18789")).toContain("Use wss://");
        return "ws://openclaw-gateway.ai:18789";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next } = await runRemotePrompt({
      text,
      confirm: false,
      selectResponses: { "Gateway auth": "off" },
    });

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("ws://openclaw-gateway.ai:18789");
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
      if (params.message === "Gateway auth") {
        return "token" as never;
      }
      if (params.message === "How do you want to provide this gateway token?") {
        return "ref" as never;
      }
      if (params.message === "Where is this gateway token stored?") {
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
});
