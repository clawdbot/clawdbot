import path from "node:path";
import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withTempSecretFiles } from "../../test-utils/secret-file-fixture.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const startGatewayServer = vi.fn(async (_port: number, _opts?: unknown) => ({
  close: vi.fn(async () => {}),
}));
const setGatewayWsLogStyle = vi.fn((_style: string) => undefined);
const setVerbose = vi.fn((_enabled: boolean) => undefined);
const setConsoleSubsystemFilter = vi.fn((_filters: string[]) => undefined);
const forceFreePortAndWait = vi.fn(async (_port: number, _opts: unknown) => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const waitForPortBindable = vi.fn(async (_port: number, _opts?: unknown) => 0);
const ensureDevGatewayConfig = vi.fn(async (_opts?: unknown) => {});
const runGatewayLoop = vi.fn(async ({ start }: { start: () => Promise<unknown> }) => {
  await start();
});
const gatewayLogMessages = vi.hoisted(() => [] as string[]);
const configState = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  snapshot: { exists: false } as Record<string, unknown>,
}));
const readBestEffortConfig = vi.fn(async () => configState.cfg);
const readConfigFileSnapshotWithPluginMetadata = vi.fn(async () => ({
  snapshot: configState.snapshot,
}));
const writeDiagnosticStabilityBundleForFailureSync = vi.fn((_reason: string, _error: unknown) => ({
  status: "written" as const,
  message: "wrote stability bundle: /tmp/openclaw-stability.json",
  path: "/tmp/openclaw-stability.json",
}));
const controlUiState = vi.hoisted(() => ({
  root: "/tmp/openclaw-control-ui" as string | null,
}));
const withoutSupervisorEnv = Object.fromEntries(
  SUPERVISOR_HINT_ENV_VARS.map((key) => [key, undefined]),
) as Record<string, string | undefined>;

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  readBestEffortConfig: () => readBestEffortConfig(),
  readConfigFileSnapshot: async () => configState.snapshot,
  readConfigFileSnapshotWithPluginMetadata: () => readConfigFileSnapshotWithPluginMetadata(),
}));

vi.mock("../../config/paths.js", () => ({
  CONFIG_PATH: "/tmp/openclaw-test-missing-config.json",
  resolveStateDir: () => "/tmp",
  resolveGatewayPort: (cfg?: { gateway?: { port?: number } }) => cfg?.gateway?.port ?? 18789,
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (params: {
    authConfig?: { mode?: string; token?: unknown; password?: unknown };
    authOverride?: { mode?: string; token?: unknown; password?: unknown };
    env?: NodeJS.ProcessEnv;
  }) => {
    const mode = params.authOverride?.mode ?? params.authConfig?.mode ?? "token";
    const token =
      (typeof params.authOverride?.token === "string" ? params.authOverride.token : undefined) ??
      (typeof params.authConfig?.token === "string" ? params.authConfig.token : undefined) ??
      params.env?.OPENCLAW_GATEWAY_TOKEN;
    const password =
      (typeof params.authOverride?.password === "string"
        ? params.authOverride.password
        : undefined) ??
      (typeof params.authConfig?.password === "string" ? params.authConfig.password : undefined) ??
      params.env?.OPENCLAW_GATEWAY_PASSWORD;
    return {
      mode,
      token,
      password,
      allowTailscale: false,
    };
  },
}));

vi.mock("../../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../../infra/control-ui-assets.js", () => ({
  resolveControlUiRootSync: () => controlUiState.root,
}));

vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: (style: string) => setGatewayWsLogStyle(style),
}));

vi.mock("../../globals.js", () => ({
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  GatewayLockError: class GatewayLockError extends Error {},
}));

vi.mock("../../infra/ports.js", () => ({
  formatPortDiagnostics: () => [],
  inspectPortUsage: async () => ({ status: "free" }),
}));

vi.mock("../../infra/supervisor-markers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/supervisor-markers.js")>();
  return {
    ...actual,
    detectRespawnSupervisor: () => null,
  };
});

vi.mock("../../logging/console.js", () => ({
  setConsoleSubsystemFilter: (filters: string[]) => setConsoleSubsystemFilter(filters),
  setConsoleTimestampPrefix: () => undefined,
}));

vi.mock("../../logging/diagnostic-stability-bundle.js", () => ({
  writeDiagnosticStabilityBundleForFailureSync: (reason: string, error: unknown) =>
    writeDiagnosticStabilityBundleForFailureSync(reason, error),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: (message: string) => {
      gatewayLogMessages.push(message);
    },
    warn: (message: string) => {
      gatewayLogMessages.push(message);
    },
    error: () => undefined,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../ports.js", () => ({
  forceFreePortAndWait: (port: number, opts: unknown) => forceFreePortAndWait(port, opts),
  waitForPortBindable: (port: number, opts?: unknown) => waitForPortBindable(port, opts),
}));

vi.mock("./dev.js", () => ({
  ensureDevGatewayConfig: (opts?: unknown) => ensureDevGatewayConfig(opts),
}));

vi.mock("./run-loop.js", () => ({
  runGatewayLoop: (params: { start: () => Promise<unknown> }) => runGatewayLoop(params),
}));

describe("gateway run option collisions", () => {
  let addGatewayRunCommand: typeof import("./run.js").addGatewayRunCommand;
  let sharedProgram: Command;

  beforeAll(async () => {
    ({ addGatewayRunCommand } = await import("./run.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    const gateway = addGatewayRunCommand(sharedProgram.command("gateway"));
    addGatewayRunCommand(gateway.command("run"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    configState.cfg = {};
    configState.snapshot = { exists: false };
    readBestEffortConfig.mockClear();
    readConfigFileSnapshotWithPluginMetadata.mockClear();
    controlUiState.root = "/tmp/openclaw-control-ui";
    gatewayLogMessages.length = 0;
    writeDiagnosticStabilityBundleForFailureSync.mockClear();
    startGatewayServer.mockClear();
    setGatewayWsLogStyle.mockClear();
    setVerbose.mockClear();
    setConsoleSubsystemFilter.mockClear();
    forceFreePortAndWait.mockClear();
    waitForPortBindable.mockClear();
    ensureDevGatewayConfig.mockClear();
    runGatewayLoop.mockClear();
  });

  async function runGatewayCli(argv: string[]) {
    await sharedProgram.parseAsync(argv, { from: "user" });
  }

  function expectAuthOverrideMode(mode: string) {
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          mode,
        }),
      }),
    );
  }

  it("forwards parent-captured options to `gateway run` subcommand", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--token",
      "tok_run",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(forceFreePortAndWait).toHaveBeenCalledWith(18789, expect.anything());
    expect(waitForPortBindable).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({ intervalMs: 150, timeoutMs: 3000 }),
    );
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "tok_run",
        }),
      }),
    );
  });

  it("blocks --force port cleanup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to force-kill gateway port listeners");
  });

  it("blocks service-mode startup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };
    const previousMarker = process.env.OPENCLAW_SERVICE_MARKER;
    process.env.OPENCLAW_SERVICE_MARKER = "gateway";
    try {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    } finally {
      if (previousMarker === undefined) {
        delete process.env.OPENCLAW_SERVICE_MARKER;
      } else {
        process.env.OPENCLAW_SERVICE_MARKER = previousMarker;
      }
    }

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to start the gateway service");
  });

  it.each([
    ["--cli-backend-logs", "generic flag"],
    ["--claude-cli-logs", "deprecated alias"],
  ])("enables CLI backend log filtering via %s (%s)", async (flag) => {
    delete process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT;

    await runGatewayCli(["gateway", "run", flag, "--allow-unconfigured"]);

    expect(setConsoleSubsystemFilter).toHaveBeenCalledWith(["agent/cli-backend"]);
    expect(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT).toBe("1");
  });

  it("starts gateway when token mode has no configured token (startup bootstrap path)", async () => {
    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(readBestEffortConfig).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
        startupConfigSnapshotRead: {
          snapshot: configState.snapshot,
        },
      }),
    );
  });

  it("logs when first startup will build missing Control UI assets", async () => {
    controlUiState.root = null;

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(gatewayLogMessages).toContain(
      "Control UI assets are missing; first startup may spend a few seconds building them before the gateway binds. `pnpm gateway:watch` does not rebuild Control UI assets, so rerun `pnpm ui:build` after UI changes or use `pnpm ui:dev` while developing the Control UI. For a full local dist, run `pnpm build && pnpm ui:build`.",
    );
  });

  it("does not write startup failure bundles for expected gateway lock conflicts", async () => {
    const err = Object.assign(new Error("gateway already running on port 18789"), {
      name: "GatewayLockError",
    });
    startGatewayServer.mockRejectedValueOnce(err);

    await withEnvAsync(withoutSupervisorEnv, async () => {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:0",
      );
    });

    expect(writeDiagnosticStabilityBundleForFailureSync).not.toHaveBeenCalled();
  });

  it("blocks startup when the observed snapshot loses gateway.mode", async () => {
    configState.cfg = {
      gateway: {
        mode: "local",
      },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: {
        update: { channel: "beta" },
      },
      parsed: {
        update: { channel: "beta" },
      },
    };

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:78");

    expect(runtimeErrors).toContain(
      "Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
    );
    expect(runtimeErrors).toContain(
      `Config write audit: ${path.join("/tmp", "logs", "config-audit.jsonl")}`,
    );
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(readBestEffortConfig).not.toHaveBeenCalled();
  });

  it("blocks invalid startup config without automatic recovery", async () => {
    configState.cfg = {};
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:78");

    expect(runtimeErrors).toContain(
      "Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
    );
    expect(runtimeErrors).toContain(
      `Config write audit: ${path.join("/tmp", "logs", "config-audit.jsonl")}`,
    );
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledOnce();
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("passes invalid startup snapshot through when explicitly allowed", async () => {
    configState.cfg = {};
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
        startupConfigSnapshotRead: expect.objectContaining({
          snapshot: expect.objectContaining({ valid: false }),
        }),
      }),
    );
  });

  it.each(["none", "trusted-proxy"] as const)("accepts --auth %s override", async (mode) => {
    await runGatewayCli(["gateway", "run", "--auth", mode, "--allow-unconfigured"]);

    expectAuthOverrideMode(mode);
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --auth (use "none", "token", "password", or "trusted-proxy")',
    );
  });

  it("allows password mode preflight when password is configured via SecretRef", async () => {
    configState.cfg = {
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: configState.cfg,
      parsed: configState.cfg,
    };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
      }),
    );
  });

  it("reads gateway password from --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await runGatewayCli([
          "gateway",
          "run",
          "--auth",
          "password",
          "--password-file",
          passwordFile ?? "",
          "--allow-unconfigured",
        ]);
      },
    );

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          mode: "password",
          password: "pw_from_file", // pragma: allowlist secret
        }),
      }),
    );
    expect(runtimeErrors).not.toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("warns when gateway password is passed inline", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--auth",
      "password",
      "--password",
      "pw_inline",
      "--allow-unconfigured",
    ]);

    expect(runtimeErrors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("rejects using both --password and --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await expect(
          runGatewayCli([
            "gateway",
            "run",
            "--password",
            "pw_inline",
            "--password-file",
            passwordFile ?? "",
            "--allow-unconfigured",
          ]),
        ).rejects.toThrow("__exit__:1");
      },
    );
    expect(runtimeErrors[0]).toContain("Use either --passw***d or --password-file.");
  });
});
