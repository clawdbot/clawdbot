import { describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({
  gateway: {
    mode: "remote",
    remote: { url: "ws://remote.example:18789", token: "rtok" },
    auth: { token: "ltok" },
  },
}));
const resolveGatewayPort = vi.fn(() => 18789);
const discoverGatewayBeacons = vi.fn(async () => []);
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.10");
const sshStop = vi.fn(async () => {});
const resolveSshConfig = vi.fn(async () => null);
const startSshPortForward = vi.fn(async () => ({
  parsedTarget: { user: "me", host: "studio", port: 22 },
  localPort: 18789,
  remotePort: 18789,
  pid: 123,
  stderr: [],
  stop: sshStop,
}));
const probeGateway = vi.fn(async ({ url }: { url: string }) => {
  if (url.includes("127.0.0.1")) {
    return {
      ok: true,
      url,
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: { ok: true },
      status: {
        linkChannel: {
          id: "whatsapp",
          label: "WhatsApp",
          linked: false,
          authAgeMs: null,
        },
        sessions: { count: 0 },
      },
      presence: [{ mode: "gateway", reason: "self", host: "local", ip: "127.0.0.1" }],
      configSnapshot: {
        path: "/tmp/cfg.json",
        exists: true,
        valid: true,
        config: {
          gateway: { mode: "local" },
        },
        issues: [],
        legacyIssues: [],
      },
    };
  }
  return {
    ok: true,
    url,
    connectLatencyMs: 34,
    error: null,
    close: null,
    health: { ok: true },
    status: {
      linkChannel: {
        id: "whatsapp",
        label: "WhatsApp",
        linked: true,
        authAgeMs: 5_000,
      },
      sessions: { count: 2 },
    },
    presence: [{ mode: "gateway", reason: "self", host: "remote", ip: "100.64.0.2" }],
    configSnapshot: {
      path: "/tmp/remote.json",
      exists: true,
      valid: true,
      config: { gateway: { mode: "remote" } },
      issues: [],
      legacyIssues: [],
    },
  };
});

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  resolveGatewayPort: (cfg: unknown) => resolveGatewayPort(cfg),
}));

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: (opts: unknown) => discoverGatewayBeacons(opts),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
}));

vi.mock("../infra/ssh-tunnel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/ssh-tunnel.js")>();
  return {
    ...actual,
    startSshPortForward: (opts: unknown) => startSshPortForward(opts),
  };
});

vi.mock("../infra/ssh-config.js", () => ({
  resolveSshConfig: (opts: unknown) => resolveSshConfig(opts),
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

describe("gateway-status command", () => {
  it("prints human output by default", async () => {
    const runtimeLogs: string[] = [];
    const runtimeErrors: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (msg: string) => runtimeErrors.push(msg),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000" },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    expect(runtimeErrors).toHaveLength(0);
    expect(runtimeLogs.join("\n")).toContain("Gateway Status");
    expect(runtimeLogs.join("\n")).toContain("Discovery (this machine)");
    expect(runtimeLogs.join("\n")).toContain("Targets");
  });

  it("prints a structured JSON envelope when --json is set", async () => {
    const runtimeLogs: string[] = [];
    const runtimeErrors: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (msg: string) => runtimeErrors.push(msg),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000", json: true },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.targets).toBeTruthy();
    const targets = parsed.targets as Array<Record<string, unknown>>;
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets[0]?.health).toBeTruthy();
    expect(targets[0]?.summary).toBeTruthy();
  });

  it("supports SSH tunnel targets", async () => {
    const runtimeLogs: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (_msg: string) => {},
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    startSshPortForward.mockClear();
    sshStop.mockClear();
    probeGateway.mockClear();

    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000", json: true, ssh: "me@studio" },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    expect(startSshPortForward).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalled();
    const tunnelCall = probeGateway.mock.calls.find(
      (call) => typeof call?.[0]?.url === "string" && call[0].url.startsWith("ws://127.0.0.1:"),
    )?.[0] as { auth?: { token?: string } } | undefined;
    expect(tunnelCall?.auth?.token).toBe("rtok");
    expect(sshStop).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    const targets = parsed.targets as Array<Record<string, unknown>>;
    expect(targets.some((t) => t.kind === "sshTunnel")).toBe(true);
  });

  it("infers SSH target from gateway.remote.url and ssh config", async () => {
    const runtimeLogs: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (_msg: string) => {},
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    const originalUser = process.env.USER;
    try {
      process.env.USER = "steipete";
      loadConfig.mockReturnValueOnce({
        gateway: {
          mode: "remote",
          remote: { url: "ws://peters-mac-studio-1.sheep-coho.ts.net:18789", token: "rtok" },
        },
      });
      resolveSshConfig.mockResolvedValueOnce({
        user: "steipete",
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        port: 2222,
        identityFiles: ["/tmp/id_ed25519"],
      });

      startSshPortForward.mockClear();
      const { gatewayStatusCommand } = await import("./gateway-status.js");
      await gatewayStatusCommand(
        { timeout: "1000", json: true },
        runtime as unknown as import("../runtime.js").RuntimeEnv,
      );

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
        identity?: string;
      };
      expect(call.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
      expect(call.identity).toBe("/tmp/id_ed25519");
    } finally {
      process.env.USER = originalUser;
    }
  });

  it("falls back to host-only when USER is missing and ssh config is unavailable", async () => {
    const runtimeLogs: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (_msg: string) => {},
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    const originalUser = process.env.USER;
    try {
      process.env.USER = "";
      loadConfig.mockReturnValueOnce({
        gateway: {
          mode: "remote",
          remote: { url: "ws://studio.example:18789", token: "rtok" },
        },
      });
      resolveSshConfig.mockResolvedValueOnce(null);

      startSshPortForward.mockClear();
      const { gatewayStatusCommand } = await import("./gateway-status.js");
      await gatewayStatusCommand(
        { timeout: "1000", json: true },
        runtime as unknown as import("../runtime.js").RuntimeEnv,
      );

      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
      };
      expect(call.target).toBe("studio.example");
    } finally {
      process.env.USER = originalUser;
    }
  });

  it("keeps explicit SSH identity even when ssh config provides one", async () => {
    const runtimeLogs: string[] = [];
    const runtime = {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (_msg: string) => {},
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    };

    loadConfig.mockReturnValueOnce({
      gateway: {
        mode: "remote",
        remote: { url: "ws://studio.example:18789", token: "rtok" },
      },
    });
    resolveSshConfig.mockResolvedValueOnce({
      user: "me",
      host: "studio.example",
      port: 22,
      identityFiles: ["/tmp/id_from_config"],
    });

    startSshPortForward.mockClear();
    const { gatewayStatusCommand } = await import("./gateway-status.js");
    await gatewayStatusCommand(
      { timeout: "1000", json: true, sshIdentity: "/tmp/explicit_id" },
      runtime as unknown as import("../runtime.js").RuntimeEnv,
    );

    const call = startSshPortForward.mock.calls[0]?.[0] as {
      identity?: string;
    };
    expect(call.identity).toBe("/tmp/explicit_id");
  });
});
