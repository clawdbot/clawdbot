import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  resolveConnectedControlUiPresenceKeys,
  runBrowserHatchHandoff,
} from "./onboard-browser-handoff.js";

const sharedMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  waitForControlUiDocument: vi.fn(),
  issueControlUiBrowserHandoff: vi.fn(),
  detectBrowserOpenSupport: vi.fn(),
  resolveAdvertisedLanHostCore: vi.fn(),
  resolveAdvertisedControlUiLinks: vi.fn(),
}));

vi.mock("../infra/advertised-lan-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/advertised-lan-host.js")>()),
  resolveAdvertisedLanHostCore: sharedMocks.resolveAdvertisedLanHostCore,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: sharedMocks.callGateway,
}));

vi.mock("./control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-handoff.js")>()),
  waitForControlUiDocument: sharedMocks.waitForControlUiDocument,
  issueControlUiBrowserHandoff: sharedMocks.issueControlUiBrowserHandoff,
}));

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  detectBrowserOpenSupport: sharedMocks.detectBrowserOpenSupport,
  resolveAdvertisedControlUiLinks: sharedMocks.resolveAdvertisedControlUiLinks,
}));

const target = {
  config: {},
  dashboardUrl: "http://127.0.0.1:18789/",
  documentUrl: "http://127.0.0.1:18789/",
  sshHint: "ssh -N -L 18789:127.0.0.1:18789 user@host",
  port: 18789,
  token: "test-token",
};

beforeEach(() => {
  sharedMocks.callGateway.mockReset();
  sharedMocks.waitForControlUiDocument.mockReset();
  sharedMocks.waitForControlUiDocument.mockResolvedValue({ ready: true });
  sharedMocks.issueControlUiBrowserHandoff.mockReset();
  sharedMocks.issueControlUiBrowserHandoff.mockImplementation(async (url: string) => ({
    browserUrl: `${url}#bootstrapToken=one-time-bootstrap`,
    expiresAtMs: 123_456,
  }));
  sharedMocks.detectBrowserOpenSupport.mockReset().mockResolvedValue({ ok: false });
  sharedMocks.resolveAdvertisedLanHostCore.mockReset();
  sharedMocks.resolveAdvertisedLanHostCore.mockResolvedValue(null);
  sharedMocks.resolveAdvertisedControlUiLinks.mockReset();
});

const connectedControlUiPresence = {
  host: GATEWAY_CLIENT_IDS.CONTROL_UI,
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  reason: "connect",
  deviceId: "same-device",
  instanceId: "existing-tab",
  text: "Control UI",
  ts: 1,
};

describe("resolveConnectedControlUiPresenceKeys", () => {
  it("uses connection identity instead of mutable presence freshness", () => {
    const baseline = resolveConnectedControlUiPresenceKeys([connectedControlUiPresence]);

    expect(
      resolveConnectedControlUiPresenceKeys([{ ...connectedControlUiPresence, ts: 2 }]),
    ).toEqual(baseline);
    expect(
      resolveConnectedControlUiPresenceKeys([
        { ...connectedControlUiPresence, instanceId: "new-tab", ts: 2 },
      ]),
    ).not.toEqual(baseline);
    expect(
      resolveConnectedControlUiPresenceKeys([
        { ...connectedControlUiPresence, reason: "disconnect", ts: 2 },
      ]),
    ).toEqual([]);
  });
});

describe("runBrowserHatchHandoff", () => {
  it("does not hand off when only an existing Control UI heartbeat changes", async () => {
    const prompter = createWizardPrompter();
    let elapsedMs = 0;

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: { DISPLAY: ":0" },
        platform: "linux",
        openBrowser: vi.fn(async () => true),
        resolveTarget: async () => target,
        probePresence: async () => ({
          reachable: true,
          clientKeys: resolveConnectedControlUiPresenceKeys([
            { ...connectedControlUiPresence, ts: elapsedMs },
          ]),
        }),
        now: () => elapsedMs,
        sleep: async (ms) => {
          elapsedMs += ms;
        },
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "timeout" });
    expect(prompter.note).not.toHaveBeenCalledWith(
      "Dashboard connected — continuing in your browser.",
      expect.anything(),
    );
  });

  it.each([
    { platform: "darwin" as const, env: {} },
    { platform: "linux" as const, env: { DISPLAY: ":0" } },
    { platform: "linux" as const, env: { WSL_DISTRO_NAME: "Ubuntu" } },
    { platform: "win32" as const, env: {} },
  ])("opens once in a $platform GUI session", async ({ platform, env }) => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValueOnce({ ok: true, command: "opener" });
    const prompter = createWizardPrompter();
    const openBrowser = vi.fn(async () => true);
    const probePresence = vi
      .fn()
      .mockResolvedValueOnce({ reachable: true as const, clientKeys: [] })
      .mockResolvedValue({ reachable: true as const, clientKeys: ["new-control-ui"] });

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env,
        platform,
        openBrowser,
        resolveTarget: async () => target,
        probePresence,
      },
    );

    expect(result).toEqual({ handedOff: true });
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(sharedMocks.detectBrowserOpenSupport).toHaveBeenCalledWith(
      expect.objectContaining({ env, platform }),
    );
    expect(openBrowser).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=one-time-bootstrap",
    );
    expect(sharedMocks.issueControlUiBrowserHandoff).toHaveBeenCalledWith(target.dashboardUrl);
    expect(probePresence).toHaveBeenCalledTimes(2);
    expect(prompter.note).toHaveBeenCalledWith(
      "Dashboard connected — continuing in your browser.",
      "Continue in your browser",
    );
  });

  it("probes the configured Gateway without a redundant target URL", async () => {
    const config = { gateway: { port: 19001 } };
    const configuredTarget = {
      ...target,
      config,
      port: 19001,
      dashboardUrl: "http://127.0.0.1:19001/",
      documentUrl: "http://127.0.0.1:19001/",
    };
    sharedMocks.callGateway
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([connectedControlUiPresence]);

    const result = await runBrowserHatchHandoff(
      { config, prompter: createWizardPrompter() },
      {
        env: {},
        platform: "darwin",
        openBrowser: vi.fn(async () => true),
        resolveTarget: async () => configuredTarget,
      },
    );

    expect(result).toEqual({ handedOff: true });
    expect(sharedMocks.callGateway).toHaveBeenCalledTimes(2);
    for (const [options] of sharedMocks.callGateway.mock.calls) {
      expect(options).toMatchObject({
        config,
        method: "system-presence",
        token: "test-token",
        ignoreEnvUrlOverride: true,
      });
      expect(options).not.toHaveProperty("url");
    }
  });

  it("prints only the clean URL and waits longer in headless Linux", async () => {
    const prompter = createWizardPrompter();
    const openBrowser = vi.fn(async () => true);
    const probePresence = vi.fn(async () => ({ reachable: true as const, clientKeys: [] }));
    const pollForClient = vi.fn(async ({ baselineClientKeys }) => {
      expect([...baselineClientKeys]).toEqual([]);
      return { connected: true as const };
    });

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "linux",
        openBrowser,
        resolveTarget: async () => target,
        probePresence,
        pollForClient,
      },
    );

    expect(result).toEqual({ handedOff: true });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
    expect(pollForClient).toHaveBeenCalledWith(
      expect.objectContaining({ target, timeoutMs: 300_000 }),
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(target.dashboardUrl),
      "Continue in your browser",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(target.sshHint),
      "Continue in your browser",
    );
    const displayed = vi
      .mocked(prompter.note)
      .mock.calls.map(([message]) => message)
      .join("\n");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
    expect(displayed).not.toContain("#bootstrapToken=");
  });

  it("prints an HTTPS tunnel destination for a headless loopback TLS Gateway", async () => {
    const prompter = createWizardPrompter();
    const config = {
      gateway: {
        port: 18789,
        bind: "loopback" as const,
        controlUi: { basePath: "/control" },
        tls: { enabled: true },
      },
    };

    await runBrowserHatchHandoff(
      { config, prompter },
      {
        env: {},
        platform: "linux",
        waitForDocument: async () => ({ ready: true }),
        verifyLoopbackAlias: async () => true,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    const displayed = vi
      .mocked(prompter.note)
      .mock.calls.map(([message]) => message)
      .join("\n");
    expect(displayed).toContain("https://localhost:18789/control/");
    expect(displayed).not.toContain("http://localhost:18789/control/");
  });

  it.each([
    {
      openerOutcome: "returns false",
      openBrowser: vi.fn(async () => false),
    },
    {
      openerOutcome: "rejects",
      openBrowser: vi.fn(async () => {
        throw new Error("browser command failed");
      }),
    },
  ])(
    "falls back to the SSH hint and manual timeout when the browser opener $openerOutcome",
    async ({ openBrowser }) => {
      sharedMocks.detectBrowserOpenSupport.mockResolvedValueOnce({
        ok: true,
        command: "xdg-open",
      });
      const prompter = createWizardPrompter();
      const pollForClient = vi.fn(async () => ({
        connected: false as const,
        reason: "timeout" as const,
      }));
      const env = {
        DISPLAY: "localhost:10.0",
        SSH_CONNECTION: "192.0.2.1 12345 192.0.2.2 22",
      };

      const result = await runBrowserHatchHandoff(
        { config: {}, prompter },
        {
          env,
          platform: "linux",
          openBrowser,
          resolveTarget: async () => target,
          probePresence: async () => ({ reachable: true, clientKeys: [] }),
          pollForClient,
        },
      );

      expect(result).toEqual({ handedOff: false, reason: "timeout" });
      expect(sharedMocks.detectBrowserOpenSupport).toHaveBeenCalledWith(
        expect.objectContaining({ env, platform: "linux" }),
      );
      expect(openBrowser).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/#bootstrapToken=one-time-bootstrap",
      );
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining(target.sshHint),
        "Continue in your browser",
      );
      expect(pollForClient).toHaveBeenCalledWith(
        expect.objectContaining({ target, timeoutMs: 300_000 }),
      );
    },
  );

  it("prints the URL when browser launch fails", async () => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValueOnce({ ok: true, command: "open" });
    const prompter = createWizardPrompter();

    await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "darwin",
        openBrowser: vi.fn(async () => false),
        resolveTarget: async () => target,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(target.dashboardUrl),
      "Continue in your browser",
    );
    const displayed = vi
      .mocked(prompter.note)
      .mock.calls.map(([message]) => message)
      .join("\n");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#bootstrapToken=");
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining(target.sshHint),
      "Continue in your browser",
    );
  });

  it.each([
    { bind: "lan" as const, host: "10.211.55.3" },
    { bind: "tailnet" as const, host: "100.64.0.8" },
    { bind: "custom" as const, host: "10.211.55.4" },
  ])("tunnels headless plaintext $bind binds through secure localhost", async ({ bind, host }) => {
    const prompter = createWizardPrompter();
    const remoteTarget = {
      ...target,
      config: {
        gateway: {
          bind,
          ...(bind === "custom" ? { customBindHost: host } : {}),
          controlUi: { basePath: "/dashboard" },
        },
      },
      dashboardUrl: "http://127.0.0.1:18789/dashboard/",
      documentUrl: "http://127.0.0.1:18789/dashboard/",
      sshHint: undefined,
    };

    await runBrowserHatchHandoff(
      { config: remoteTarget.config, prompter },
      {
        env: {},
        platform: "linux",
        resolveTarget: async () => remoteTarget,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    const displayed = vi
      .mocked(prompter.note)
      .mock.calls.map(([message]) => message)
      .join("\n");
    expect(displayed).toContain("http://127.0.0.1:18789/dashboard/");
    expect(displayed).toContain("ssh -N -L 18789:127.0.0.1:18789");
    expect(displayed).toContain("http://localhost:18789/dashboard/");
    expect(displayed).not.toContain(`http://${host}:18789`);
    expect(displayed).not.toContain("openclaw devices approve <requestId>");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
    expect(displayed).not.toContain("#bootstrapToken=");
    expect(sharedMocks.resolveAdvertisedControlUiLinks).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
  });

  it.each([
    { bind: "lan" as const, host: "10.211.55.3" },
    { bind: "tailnet" as const, host: "100.64.0.8" },
    { bind: "custom" as const, host: "10.211.55.4" },
  ])("prints the secure advertised URL for headless TLS $bind binds", async ({ bind, host }) => {
    const prompter = createWizardPrompter();
    const remoteTarget = {
      ...target,
      config: {
        gateway: {
          bind,
          ...(bind === "custom" ? { customBindHost: host } : {}),
          controlUi: { basePath: "/dashboard" },
          tls: { enabled: true },
        },
      },
      dashboardUrl: `https://${bind === "lan" ? "127.0.0.1" : host}:18789/dashboard/`,
      documentUrl: "https://127.0.0.1:18789/dashboard/",
      tlsConfig: { enabled: true },
      sshHint: undefined,
    };
    sharedMocks.resolveAdvertisedControlUiLinks.mockResolvedValue({
      httpUrl: `https://${host}:18789/dashboard/`,
      wsUrl: `wss://${host}:18789/dashboard`,
    });

    await runBrowserHatchHandoff(
      { config: remoteTarget.config, prompter },
      {
        env: {},
        platform: "linux",
        resolveTarget: async () => remoteTarget,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    const displayed = vi
      .mocked(prompter.note)
      .mock.calls.map(([message]) => message)
      .join("\n");
    expect(displayed).toContain(`https://${host}:18789/dashboard/`);
    expect(displayed).toContain("openclaw devices approve <requestId>");
    expect(displayed).not.toContain("ssh -N -L");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
    expect(displayed).not.toContain("#bootstrapToken=");
    expect(sharedMocks.resolveAdvertisedControlUiLinks).toHaveBeenCalledWith({
      bind,
      port: 18789,
      customBindHost: bind === "custom" ? host : undefined,
      basePath: "/dashboard",
      tlsEnabled: true,
    });
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
  });

  it("keeps headless TLS handoff available when all LAN discovery fails", async () => {
    const prompter = createWizardPrompter();
    const remoteTarget = {
      ...target,
      config: {
        gateway: {
          bind: "lan" as const,
          controlUi: { basePath: "/dashboard" },
          tls: { enabled: true },
        },
      },
      dashboardUrl: "https://127.0.0.1:18789/dashboard/",
      documentUrl: "https://127.0.0.1:18789/dashboard/",
      tlsConfig: { enabled: true },
      sshHint: undefined,
    };
    sharedMocks.resolveAdvertisedLanHostCore.mockRejectedValue(
      new Error("default route unavailable"),
    );
    sharedMocks.resolveAdvertisedControlUiLinks.mockImplementation(async (params) => {
      const { resolveAdvertisedControlUiLinks } = await import("../gateway/control-ui-links.js");
      return await resolveAdvertisedControlUiLinks(params);
    });
    const networkInterfaces = vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
    });

    try {
      const result = await runBrowserHatchHandoff(
        { config: remoteTarget.config, prompter },
        {
          env: {},
          platform: "linux",
          resolveTarget: async () => remoteTarget,
          probePresence: async () => ({ reachable: true, clientKeys: [] }),
          pollForClient: async () => ({ connected: true }),
        },
      );

      expect(result).toEqual({ handedOff: true });
      expect(sharedMocks.resolveAdvertisedLanHostCore).toHaveBeenCalledOnce();
      expect(networkInterfaces).toHaveBeenCalled();
      const displayed = vi
        .mocked(prompter.note)
        .mock.calls.map(([message]) => message)
        .join("\n");
      expect(displayed).toContain("https://127.0.0.1:18789/dashboard/");
      expect(displayed).not.toContain("test-token");
      expect(displayed).not.toContain("#token=");
      expect(displayed).not.toContain("#bootstrapToken=");
    } finally {
      networkInterfaces.mockRestore();
    }
  });

  it("keeps resolved password SecretRefs inside the Gateway presence request", async () => {
    const prompter = createWizardPrompter();
    const gatewayPassword = ["private", "password"].join("-");
    const config = {
      secrets: {
        providers: { default: { source: "env" as const } },
        defaults: { env: "default" },
      },
      gateway: {
        auth: {
          mode: "password" as const,
          password: { source: "env" as const, provider: "default", id: "DASHBOARD_TEST_PASSWORD" },
        },
      },
    };
    const probePresence = vi.fn(async (resolvedTarget: { password?: string }) => {
      expect(resolvedTarget.password).toBe(gatewayPassword);
      return { reachable: true as const, clientKeys: [] };
    });

    await runBrowserHatchHandoff(
      { config, prompter },
      {
        env: { DASHBOARD_TEST_PASSWORD: gatewayPassword },
        platform: "linux",
        probePresence,
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(probePresence).toHaveBeenCalledOnce();
    const displayed = vi
      .mocked(prompter.note)
      .mock.calls.map(([message]) => message)
      .join("\n");
    expect(displayed).not.toContain(gatewayPassword);
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
  });

  it("returns the poll timeout without claiming a handoff", async () => {
    const prompter = createWizardPrompter();

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: { DISPLAY: ":0" },
        platform: "linux",
        openBrowser: vi.fn(async () => true),
        resolveTarget: async () => target,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "timeout" });
    expect(prompter.note).not.toHaveBeenCalledWith(
      "Dashboard connected — continuing in your browser.",
      expect.anything(),
    );
  });

  it("bounds the final presence probe by the remaining handoff time", async () => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValueOnce({ ok: true, command: "open" });
    const prompter = createWizardPrompter();
    const probeTimeouts: number[] = [];
    let elapsedMs = 0;
    let baselineCaptured = false;

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "darwin",
        openBrowser: vi.fn(async () => true),
        resolveTarget: async () => target,
        probePresence: async (_target, timeoutMs) => {
          probeTimeouts.push(timeoutMs);
          if (!baselineCaptured) {
            baselineCaptured = true;
            return { reachable: true, clientKeys: ["existing-control-ui"] };
          }
          elapsedMs += timeoutMs / 2;
          return { reachable: true, clientKeys: ["existing-control-ui"] };
        },
        now: () => elapsedMs,
        sleep: async (ms) => {
          elapsedMs += ms;
        },
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "timeout" });
    expect(elapsedMs).toBe(60_000);
    expect(probeTimeouts.at(-1)).toBe(1_000);
    expect(probeTimeouts.every((timeoutMs) => timeoutMs <= 5_000)).toBe(true);
  });

  it("does not open or issue credentials when token output suppresses the Control UI", async () => {
    const prompter = createWizardPrompter();
    const resolveTarget = vi.fn(async () => target);
    const openBrowser = vi.fn(async () => true);

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter, suppressTokenOutput: true },
      {
        env: {},
        platform: "darwin",
        openBrowser,
        resolveTarget,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "target-unavailable" });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(sharedMocks.waitForControlUiDocument).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("skips a disabled Control UI before probing or issuing credentials", async () => {
    const prompter = createWizardPrompter();
    const resolveTarget = vi.fn(async () => target);

    const result = await runBrowserHatchHandoff(
      { config: { gateway: { controlUi: { enabled: false } } }, prompter },
      { resolveTarget },
    );

    expect(result).toEqual({ handedOff: false, reason: "target-unavailable" });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
  });

  it("does not issue browser credentials while the dashboard document is unavailable", async () => {
    const prompter = createWizardPrompter();
    sharedMocks.waitForControlUiDocument.mockResolvedValue({
      ready: false,
      reason: "Control UI build failed.",
      status: 503,
    });
    const probePresence = vi.fn();
    const openBrowser = vi.fn();

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "darwin",
        resolveTarget: async () => target,
        probePresence,
        openBrowser,
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "target-unavailable" });
    expect(probePresence).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("starts and stops preparation progress only when the document reports pending", async () => {
    const stop = vi.fn();
    const prompter = createWizardPrompter({
      progress: vi.fn(() => ({ update: vi.fn(), stop })),
    });
    sharedMocks.waitForControlUiDocument.mockImplementation(async ({ onPending }) => {
      onPending?.();
      return { ready: true };
    });

    await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "darwin",
        resolveTarget: async () => target,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        openBrowser: async () => true,
        pollForClient: async () => ({ connected: false, reason: "timeout" }),
      },
    );

    expect(prompter.progress).toHaveBeenCalledWith("Preparing the Control UI…");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("fails safely when a GUI browser bootstrap cannot be issued", async () => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValueOnce({ ok: true, command: "open" });
    const prompter = createWizardPrompter();
    sharedMocks.issueControlUiBrowserHandoff.mockRejectedValue(new Error("state unavailable"));
    const openBrowser = vi.fn();

    const result = await runBrowserHatchHandoff(
      { config: {}, prompter },
      {
        env: {},
        platform: "darwin",
        resolveTarget: async () => target,
        probePresence: async () => ({ reachable: true, clientKeys: [] }),
        openBrowser,
      },
    );

    expect(result).toEqual({ handedOff: false, reason: "target-unavailable" });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });
});
