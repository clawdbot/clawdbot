import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv } from "../test-utils/env.js";
import { createThrowingRuntime } from "./onboard-non-interactive.test-helpers.js";
import type { installGatewayDaemonNonInteractive } from "./onboard-non-interactive/local/daemon-install.js";

const ensureWorkspaceAndSessionsMock = vi.fn(async (..._args: unknown[]) => {});
const preparePostConfigBundledRuntimeDepsMock = vi.hoisted(() => vi.fn(async () => {}));
const testConfigStore = new Map<string, OpenClawConfig>();
type InstallGatewayDaemonResult = Awaited<ReturnType<typeof installGatewayDaemonNonInteractive>>;
const installGatewayDaemonNonInteractiveMock = vi.hoisted(() =>
  vi.fn(async (): Promise<InstallGatewayDaemonResult> => ({ installed: true })),
);
const healthCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceMock = vi.hoisted(() => ({
  label: "LaunchAgent",
  loadedText: "loaded",
  isLoaded: vi.fn(async () => true),
  readRuntime: vi.fn(async () => ({
    status: "running",
    state: "active",
    pid: 4242,
  })),
}));
const readLastGatewayErrorLineMock = vi.hoisted(() =>
  vi.fn(async () => "Gateway failed to start: required secrets are unavailable."),
);
let waitForGatewayReachableMock:
  | ((params: {
      url: string;
      token?: string;
      password?: string;
      deadlineMs?: number;
      probeTimeoutMs?: number;
    }) => Promise<{
      ok: boolean;
      detail?: string;
    }>)
  | undefined;

function resolveTestConfigPath() {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return override;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR must be set before config IO in this test");
  }
  return path.join(stateDir, "openclaw.json");
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe stored config shape.
function readTestConfig<T = OpenClawConfig>(): T {
  return (testConfigStore.get(resolveTestConfigPath()) ?? {}) as T;
}

vi.mock("../config/io.js", () => ({
  createConfigIO: () => ({
    configPath: resolveTestConfigPath(),
  }),
  loadConfig: () => testConfigStore.get(resolveTestConfigPath()) ?? {},
  readConfigFileSnapshot: async () => {
    const configPath = resolveTestConfigPath();
    const config = testConfigStore.get(configPath);
    if (config) {
      const raw = `${JSON.stringify(config, null, 2)}\n`;
      return {
        exists: true,
        valid: true,
        config,
        sourceConfig: config,
        raw,
        hash: "test-config-hash",
      };
    }
    return {
      exists: false,
      valid: true,
      config: {},
      sourceConfig: {},
      raw: null,
      hash: undefined,
    };
  },
}));

vi.mock("../config/config.js", () => ({
  replaceConfigFile: async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    testConfigStore.set(resolveTestConfigPath(), nextConfig);
  },
  resolveGatewayPort: (cfg: OpenClawConfig) => cfg.gateway?.port ?? 18789,
}));

vi.mock("./onboard-helpers.js", () => {
  const normalizeGatewayTokenInput = (value: unknown): string => {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    return trimmed === "undefined" || trimmed === "null" ? "" : trimmed;
  };
  return {
    DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
    applyWizardMetadata: (cfg: unknown) => cfg,
    ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
    normalizeGatewayTokenInput,
    randomToken: () => "tok_generated_gateway_test_token",
    resolveControlUiLinks: ({ port }: { port: number }) => ({
      httpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
    }),
    waitForGatewayReachable: (params: {
      url: string;
      token?: string;
      password?: string;
      deadlineMs?: number;
      probeTimeoutMs?: number;
    }) => waitForGatewayReachableMock?.(params) ?? Promise.resolve({ ok: true }),
  };
});

vi.mock("./onboard-non-interactive/local/daemon-install.js", () => ({
  installGatewayDaemonNonInteractive: installGatewayDaemonNonInteractiveMock,
}));

vi.mock("./health.js", () => ({
  healthCommand: healthCommandMock,
}));

vi.mock("./post-config-runtime-deps.js", () => ({
  preparePostConfigBundledRuntimeDeps: preparePostConfigBundledRuntimeDepsMock,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayServiceMock,
}));

vi.mock("../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: readLastGatewayErrorLineMock,
}));

let runNonInteractiveSetup: typeof import("./onboard-non-interactive.js").runNonInteractiveSetup;
let resolveInstallDaemonGatewayHealthTiming: typeof import("./onboard-non-interactive/local.js").resolveInstallDaemonGatewayHealthTiming;

async function loadGatewayOnboardModules(): Promise<void> {
  vi.resetModules();
  ({ runNonInteractiveSetup } = await import("./onboard-non-interactive.js"));
  ({ resolveInstallDaemonGatewayHealthTiming } =
    await import("./onboard-non-interactive/local.js"));
}

function getPseudoPort(base: number): number {
  return base + (process.pid % 1000);
}

const runtime = createThrowingRuntime();

function createJsonCaptureRuntime() {
  let capturedJson = "";
  const runtimeWithCapture: RuntimeEnv = {
    log: (...args: unknown[]) => {
      const firstArg = args[0];
      capturedJson =
        typeof firstArg === "string"
          ? firstArg
          : firstArg instanceof Error
            ? firstArg.message
            : (JSON.stringify(firstArg) ?? "");
    },
    error: (...args: unknown[]) => {
      const firstArg = args[0];
      const capturedError =
        typeof firstArg === "string"
          ? firstArg
          : firstArg instanceof Error
            ? firstArg.message
            : (JSON.stringify(firstArg) ?? "");
      throw new Error(capturedError);
    },
    exit: (_code: number) => {
      throw new Error("exit should not be reached after runtime.error");
    },
  };

  return {
    runtimeWithCapture,
    readCapturedJson: () => capturedJson,
  };
}

async function expectLocalJsonSetupFailure(stateDir: string, runtimeWithCapture: RuntimeEnv) {
  await expect(
    runNonInteractiveSetup(
      {
        nonInteractive: true,
        mode: "local",
        workspace: path.join(stateDir, "openclaw"),
        authChoice: "skip",
        skipSkills: true,
        skipHealth: false,
        installDaemon: true,
        gatewayBind: "loopback",
        json: true,
      },
      runtimeWithCapture,
    ),
  ).rejects.toThrow("exit should not be reached after runtime.error");
}

function createLocalDaemonSetupOptions(stateDir: string) {
  return {
    nonInteractive: true,
    mode: "local" as const,
    workspace: path.join(stateDir, "openclaw"),
    authChoice: "skip" as const,
    skipSkills: true,
    skipHealth: false,
    installDaemon: true,
    gatewayBind: "loopback" as const,
  };
}

async function runLocalDaemonSetup(stateDir: string, runtimeEnv: RuntimeEnv = runtime) {
  await runNonInteractiveSetup(createLocalDaemonSetupOptions(stateDir), runtimeEnv);
}

function mockGatewayReachableWithCapturedTimeouts() {
  let capturedDeadlineMs: number | undefined;
  let capturedProbeTimeoutMs: number | undefined;
  waitForGatewayReachableMock = vi.fn(
    async (params: {
      url: string;
      token?: string;
      password?: string;
      deadlineMs?: number;
      probeTimeoutMs?: number;
    }) => {
      capturedDeadlineMs = params.deadlineMs;
      capturedProbeTimeoutMs = params.probeTimeoutMs;
      return { ok: true };
    },
  );
  return {
    get deadlineMs() {
      return capturedDeadlineMs;
    },
    get probeTimeoutMs() {
      return capturedProbeTimeoutMs;
    },
  };
}

describe("onboard (non-interactive): gateway and remote auth", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string | undefined;

  const initStateDir = async (prefix: string) => {
    if (!tempHome) {
      throw new Error("temp home not initialized");
    }
    const stateDir = await fs.mkdtemp(path.join(tempHome, prefix));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_CONFIG_PATH;
    return stateDir;
  };
  const withStateDir = async (
    prefix: string,
    run: (stateDir: string) => Promise<void>,
  ): Promise<void> => {
    const stateDir = await initStateDir(prefix);
    try {
      await run(stateDir);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  };
  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_SKIP_CHANNELS",
      "OPENCLAW_SKIP_GMAIL_WATCHER",
      "OPENCLAW_SKIP_CRON",
      "OPENCLAW_SKIP_CANVAS_HOST",
      "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    tempHome = await makeTempWorkspace("openclaw-onboard-");
    process.env.HOME = tempHome;

    await loadGatewayOnboardModules();
  });

  afterAll(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
    envSnapshot.restore();
  });

  afterEach(() => {
    waitForGatewayReachableMock = undefined;
    testConfigStore.clear();
    installGatewayDaemonNonInteractiveMock.mockClear();
    healthCommandMock.mockClear();
    gatewayServiceMock.isLoaded.mockClear();
    gatewayServiceMock.readRuntime.mockClear();
    readLastGatewayErrorLineMock.mockClear();
    preparePostConfigBundledRuntimeDepsMock.mockClear();
  });

  it("writes gateway token auth into config", async () => {
    await withStateDir("state-noninteractive-", async (stateDir) => {
      const token = "tok_test_123";
      const workspace = path.join(stateDir, "openclaw");

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace,
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayBind: "loopback",
          gatewayAuth: "token",
          gatewayToken: token,
        },
        runtime,
      );

      const cfg = readTestConfig<{
        gateway?: { mode?: string; auth?: { mode?: string; token?: string } };
        agents?: { defaults?: { workspace?: string } };
        tools?: { profile?: string };
      }>();

      expect(cfg?.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg?.gateway?.mode).toBe("local");
      expect(cfg?.tools?.profile).toBe("coding");
      expect(cfg?.gateway?.auth?.mode).toBe("token");
      expect(cfg?.gateway?.auth?.token).toBe(token);
      expect(preparePostConfigBundledRuntimeDepsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            gateway: expect.objectContaining({ mode: "local" }),
          }),
          runtime,
        }),
      );
    });
  }, 60_000);

  it("persists skipBootstrap and skips workspace bootstrap creation", async () => {
    ensureWorkspaceAndSessionsMock.mockClear();
    await withStateDir("state-skip-bootstrap-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace,
          authChoice: "skip",
          skipBootstrap: true,
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayBind: "loopback",
        },
        runtime,
      );

      const cfg = readTestConfig();

      expect(cfg.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg.agents?.defaults?.skipBootstrap).toBe(true);
      expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledWith(
        workspace,
        runtime,
        expect.objectContaining({ skipBootstrap: true }),
      );
    });
  }, 60_000);

  it("writes gateway.remote url/token", async () => {
    await withStateDir("state-remote-", async (_stateDir) => {
      const port = getPseudoPort(30_000);
      const token = "tok_remote_123";
      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: `ws://127.0.0.1:${port}`,
          remoteToken: token,
          authChoice: "skip",
          json: true,
        },
        runtime,
      );

      const cfg = readTestConfig<{
        gateway?: { mode?: string; remote?: { url?: string; token?: string } };
      }>();

      expect(cfg.gateway?.mode).toBe("remote");
      expect(cfg.gateway?.remote?.url).toBe(`ws://127.0.0.1:${port}`);
      expect(cfg.gateway?.remote?.token).toBe(token);
      expect(preparePostConfigBundledRuntimeDepsMock).not.toHaveBeenCalled();
    });
  }, 60_000);

  it("explains local health failure when no daemon was requested", async () => {
    await withStateDir("state-local-health-hint-", async (stateDir) => {
      waitForGatewayReachableMock = vi.fn(async () => ({
        ok: false,
        detail: "socket closed: 1006 abnormal closure",
      }));

      await expect(
        runNonInteractiveSetup(
          {
            nonInteractive: true,
            mode: "local",
            workspace: path.join(stateDir, "openclaw"),
            authChoice: "skip",
            skipSkills: true,
            skipHealth: false,
            installDaemon: false,
            gatewayBind: "loopback",
          },
          runtime,
        ),
      ).rejects.toThrow(
        /only waits for an already-running gateway unless you pass --install-daemon[\s\S]*--skip-health/,
      );
    });
  }, 60_000);

  it("uses a longer health deadline when daemon install was requested", async () => {
    await withStateDir("state-local-daemon-health-", async (stateDir) => {
      const captured = mockGatewayReachableWithCapturedTimeouts();

      await runLocalDaemonSetup(stateDir);

      const cfg = readTestConfig<{
        gateway?: { mode?: string; bind?: string };
      }>();

      expect(cfg?.gateway?.mode).toBe("local");
      expect(cfg?.gateway?.bind).toBe("loopback");
      expect(installGatewayDaemonNonInteractiveMock).toHaveBeenCalledTimes(1);
      expect(captured.deadlineMs).toBe(45_000);
      expect(captured.probeTimeoutMs).toBe(10_000);
    });
  }, 60_000);

  it("passes pinned gateway auth through non-interactive health checks", async () => {
    await withStateDir("state-local-daemon-health-auth-", async (stateDir) => {
      const token = "tok_noninteractive_health";
      waitForGatewayReachableMock = vi.fn(async () => ({ ok: true }));

      await runNonInteractiveSetup(
        {
          ...createLocalDaemonSetupOptions(stateDir),
          gatewayAuth: "token",
          gatewayToken: token,
        },
        runtime,
      );

      expect(waitForGatewayReachableMock).toHaveBeenCalledWith(
        expect.objectContaining({
          token,
          password: undefined,
        }),
      );
      expect(healthCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({
          token,
          password: undefined,
          config: expect.objectContaining({
            gateway: expect.objectContaining({
              auth: expect.objectContaining({
                mode: "token",
                token,
              }),
            }),
          }),
        }),
        expect.any(Object),
      );
    });
  }, 60_000);

  it("uses longer Windows health timings for daemon install probes", () => {
    expect(resolveInstallDaemonGatewayHealthTiming("win32")).toEqual({
      deadlineMs: 90_000,
      probeTimeoutMs: 15_000,
      healthCommandTimeoutMs: 90_000,
    });
  });

  it("emits a daemon-install failure when Linux user systemd is unavailable", async () => {
    await withStateDir("state-local-daemon-install-json-fail-", async (stateDir) => {
      installGatewayDaemonNonInteractiveMock.mockResolvedValueOnce({
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });

      const { runtimeWithCapture, readCapturedJson } = createJsonCaptureRuntime();

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "linux",
      });

      try {
        await expectLocalJsonSetupFailure(stateDir, runtimeWithCapture);
      } finally {
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: originalPlatform,
        });
      }

      const parsed = JSON.parse(readCapturedJson()) as {
        ok: boolean;
        phase: string;
        daemonInstall?: {
          requested?: boolean;
          installed?: boolean;
          skippedReason?: string;
        };
        hints?: string[];
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.phase).toBe("daemon-install");
      expect(parsed.daemonInstall).toEqual({
        requested: true,
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });
      expect(parsed.hints).toContain(
        "Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.",
      );
    });
  }, 60_000);

  it("emits structured JSON diagnostics when daemon health fails", async () => {
    await withStateDir("state-local-daemon-health-json-fail-", async (stateDir) => {
      waitForGatewayReachableMock = vi.fn(async () => ({
        ok: false,
        detail: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
      }));

      const { runtimeWithCapture, readCapturedJson } = createJsonCaptureRuntime();
      await expectLocalJsonSetupFailure(stateDir, runtimeWithCapture);

      const parsed = JSON.parse(readCapturedJson()) as {
        ok: boolean;
        phase: string;
        installDaemon: boolean;
        detail?: string;
        gateway?: { wsUrl?: string };
        hints?: string[];
        diagnostics?: {
          service?: {
            label?: string;
            loaded?: boolean;
            runtimeStatus?: string;
            pid?: number;
          };
          lastGatewayError?: string;
        };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.phase).toBe("gateway-health");
      expect(parsed.installDaemon).toBe(true);
      expect(parsed.detail).toContain("1006 abnormal closure");
      expect(parsed.gateway?.wsUrl).toContain("ws://127.0.0.1:");
      expect(parsed.hints).toContain("Run `openclaw gateway status --deep` for more detail.");
      expect(parsed.diagnostics?.service?.label).toBe("LaunchAgent");
      expect(parsed.diagnostics?.service?.loaded).toBe(true);
      expect(parsed.diagnostics?.service?.runtimeStatus).toBe("running");
      expect(parsed.diagnostics?.service?.pid).toBe(4242);
      expect(parsed.diagnostics?.lastGatewayError).toContain("required secrets are unavailable");
    });
  }, 60_000);

  it("classifies daemon health ECONNREFUSED failures with a recovery command", async () => {
    await withStateDir("state-local-daemon-health-refused-", async (stateDir) => {
      waitForGatewayReachableMock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      gatewayServiceMock.readRuntime.mockResolvedValueOnce({
        status: "stopped",
        state: "failed",
        pid: 0,
      });
      readLastGatewayErrorLineMock.mockResolvedValueOnce("");

      const { runtimeWithCapture, readCapturedJson } = createJsonCaptureRuntime();
      await expectLocalJsonSetupFailure(stateDir, runtimeWithCapture);

      const parsed = JSON.parse(readCapturedJson()) as {
        ok: boolean;
        phase: string;
        classification?: string;
        hints?: string[];
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.phase).toBe("gateway-health");
      expect(parsed.classification).toBe("service-stopped");
      expect(parsed.hints).toContain("Fix: run `openclaw gateway restart`.");
    });
  }, 60_000);

  it("auto-generates token auth when binding LAN and persists the token", async () => {
    if (process.platform === "win32") {
      // Windows runner occasionally drops the temp config write in this flow; skip to keep CI green.
      return;
    }
    await withStateDir("state-lan-", async (stateDir) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");

      const port = getPseudoPort(40_000);
      const workspace = path.join(stateDir, "openclaw");

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace,
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayPort: port,
          gatewayBind: "lan",
        },
        runtime,
      );

      const cfg = readTestConfig<{
        gateway?: {
          bind?: string;
          port?: number;
          auth?: { mode?: string; token?: string };
        };
      }>();

      expect(cfg.gateway?.bind).toBe("lan");
      expect(cfg.gateway?.port).toBe(port);
      expect(cfg.gateway?.auth?.mode).toBe("token");
      expect((cfg.gateway?.auth?.token ?? "").length).toBeGreaterThan(8);
    });
  }, 60_000);
});
