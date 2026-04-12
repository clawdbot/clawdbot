import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv } from "../test-utils/env.js";
import { createThrowingRuntime, readJsonFile } from "./onboard-non-interactive.test-helpers.js";
import type { installGatewayDaemonNonInteractive } from "./onboard-non-interactive/local/daemon-install.js";

const gatewayClientCalls: Array<{
  url?: string;
  token?: string;
  password?: string;
  onHelloOk?: (hello: { features?: { methods?: string[] } }) => void;
  onClose?: (code: number, reason: string) => void;
}> = [];
const ensureWorkspaceAndSessionsMock = vi.fn(async (..._args: unknown[]) => {});
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

vi.mock("../gateway/client.js", () => ({
  GatewayClient: class {
    params: {
      url?: string;
      token?: string;
      password?: string;
      onHelloOk?: (hello: { features?: { methods?: string[] } }) => void;
    };
    constructor(params: {
      url?: string;
      token?: string;
      password?: string;
      onHelloOk?: (hello: { features?: { methods?: string[] } }) => void;
    }) {
      this.params = params;
      gatewayClientCalls.push(params);
    }
    async request() {
      return { ok: true };
    }
    start() {
      queueMicrotask(() => this.params.onHelloOk?.({ features: { methods: ["health"] } }));
    }
    stop() {}
  },
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

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayServiceMock,
}));

vi.mock("../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: readLastGatewayErrorLineMock,
}));

let runNonInteractiveSetup: typeof import("./onboard-non-interactive.js").runNonInteractiveSetup;
let resolveStateConfigPath: typeof import("../config/paths.js").resolveConfigPath;
let callGateway: typeof import("../gateway/call.js").callGateway | undefined;

async function loadGatewayOnboardModules(): Promise<void> {
  vi.resetModules();
  ({ runNonInteractiveSetup } = await import("./onboard-non-interactive.js"));
  ({ resolveConfigPath: resolveStateConfigPath } = await import("../config/paths.js"));
}

async function loadCallGateway(): Promise<typeof import("../gateway/call.js").callGateway> {
  callGateway ??= (await import("../gateway/call.js")).callGateway;
  return callGateway;
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

async function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  try {
    return await run();
  } finally {
    platformSpy.mockRestore();
  }
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

  beforeEach(() => {
    gatewayClientCalls.length = 0;
  });

  afterAll(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
    envSnapshot.restore();
  });

  afterEach(() => {
    waitForGatewayReachableMock = undefined;
    installGatewayDaemonNonInteractiveMock.mockClear();
    healthCommandMock.mockClear();
    gatewayServiceMock.isLoaded.mockClear();
    gatewayServiceMock.readRuntime.mockClear();
    readLastGatewayErrorLineMock.mockClear();
    gatewayClientCalls.length = 0;
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

      const configPath = resolveStateConfigPath(process.env, stateDir);
      const cfg = await readJsonFile<{
        gateway?: { mode?: string; auth?: { mode?: string; token?: string } };
        agents?: { defaults?: { workspace?: string } };
        tools?: { profile?: string };
      }>(configPath);

      expect(cfg?.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg?.gateway?.mode).toBe("local");
      expect(cfg?.tools?.profile).toBe("coding");
      expect(cfg?.gateway?.auth?.mode).toBe("token");
      expect(cfg?.gateway?.auth?.token).toBe(token);
    });
  }, 60_000);

  it("keeps gateway.mode=local on the install-daemon onboarding path", async () => {
    await withStateDir("state-install-daemon-local-mode-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace,
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: true,
          gatewayBind: "loopback",
        },
        runtime,
      );

      const configPath = resolveStateConfigPath(process.env, stateDir);
      const cfg = await readJsonFile<{
        gateway?: { mode?: string; bind?: string };
      }>(configPath);

      expect(cfg?.gateway?.mode).toBe("local");
      expect(cfg?.gateway?.bind).toBe("loopback");
      expect(installGatewayDaemonNonInteractiveMock).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it("uses OPENCLAW_GATEWAY_TOKEN when --gateway-token is omitted", async () => {
    await withStateDir("state-env-token-", async (stateDir) => {
      const envToken = "tok_env_fallback_123";
      const workspace = path.join(stateDir, "openclaw");
      const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_GATEWAY_TOKEN = envToken;

      try {
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
          },
          runtime,
        );

        const configPath = resolveStateConfigPath(process.env, stateDir);
        const cfg = await readJsonFile<{
          gateway?: { auth?: { mode?: string; token?: string } };
        }>(configPath);

        expect(cfg?.gateway?.auth?.mode).toBe("token");
        expect(cfg?.gateway?.auth?.token).toBe(envToken);
      } finally {
        if (prevToken === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
        }
      }
    });
  }, 60_000);

  it("writes gateway token SecretRef from --gateway-token-ref-env", async () => {
    await withStateDir("state-env-token-ref-", async (stateDir) => {
      const envToken = "tok_env_ref_123";
      const workspace = path.join(stateDir, "openclaw");
      const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_GATEWAY_TOKEN = envToken;

      try {
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
            gatewayTokenRefEnv: "OPENCLAW_GATEWAY_TOKEN",
          },
          runtime,
        );

        const configPath = resolveStateConfigPath(process.env, stateDir);
        const cfg = await readJsonFile<{
          gateway?: { auth?: { mode?: string; token?: unknown } };
        }>(configPath);

        expect(cfg?.gateway?.auth?.mode).toBe("token");
        expect(cfg?.gateway?.auth?.token).toEqual({
          source: "env",
          provider: "default",
          id: "OPENCLAW_GATEWAY_TOKEN",
        });
      } finally {
        if (prevToken === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
        }
      }
    });
  }, 60_000);

  it("fails when --gateway-token-ref-env points to a missing env var", async () => {
    await withStateDir("state-env-token-ref-missing-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");
      const previous = process.env.MISSING_GATEWAY_TOKEN_ENV;
      delete process.env.MISSING_GATEWAY_TOKEN_ENV;
      try {
        await expect(
          runNonInteractiveSetup(
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
              gatewayTokenRefEnv: "MISSING_GATEWAY_TOKEN_ENV",
            },
            runtime,
          ),
        ).rejects.toThrow(/MISSING_GATEWAY_TOKEN_ENV/);
      } finally {
        if (previous === undefined) {
          delete process.env.MISSING_GATEWAY_TOKEN_ENV;
        } else {
          process.env.MISSING_GATEWAY_TOKEN_ENV = previous;
        }
      }
    });
  }, 60_000);

  it("writes gateway.remote url/token and callGateway uses them", async () => {
    await withStateDir("state-remote-", async (stateDir) => {
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

      const cfg = await readJsonFile<{
        gateway?: { mode?: string; remote?: { url?: string; token?: string } };
      }>(resolveStateConfigPath(process.env, stateDir));

      expect(cfg.gateway?.mode).toBe("remote");
      expect(cfg.gateway?.remote?.url).toBe(`ws://127.0.0.1:${port}`);
      expect(cfg.gateway?.remote?.token).toBe(token);

      gatewayClientCalls.length = 0;
      const health = await (await loadCallGateway())({ method: "health" });
      expect(health?.ok).toBe(true);
      const lastCall = gatewayClientCalls[gatewayClientCalls.length - 1];
      expect(lastCall?.url).toBe(`ws://127.0.0.1:${port}`);
      expect(lastCall?.token).toBe(token);
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

      expect(installGatewayDaemonNonInteractiveMock).toHaveBeenCalledTimes(1);
      expect(captured.deadlineMs).toBe(45_000);
      expect(captured.probeTimeoutMs).toBe(10_000);
    });
  }, 60_000);

  it("uses a longer Windows health deadline when daemon install was requested", async () => {
    await withStateDir("state-local-daemon-health-win-", async (stateDir) => {
      const captured = mockGatewayReachableWithCapturedTimeouts();

      await withMockedPlatform("win32", async () => {
        await runLocalDaemonSetup(stateDir);
      });

      expect(installGatewayDaemonNonInteractiveMock).toHaveBeenCalledTimes(1);
      expect(captured.deadlineMs).toBe(90_000);
      expect(captured.probeTimeoutMs).toBe(15_000);
    });
  }, 60_000);

  it("uses a longer Windows health command timeout when daemon install was requested", async () => {
    await withStateDir("state-local-daemon-health-command-win-", async (stateDir) => {
      waitForGatewayReachableMock = vi.fn(async () => ({ ok: true }));

      await withMockedPlatform("win32", async () => {
        await runLocalDaemonSetup(stateDir);
      });

      expect(healthCommandMock).toHaveBeenCalledTimes(1);
      expect(healthCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({
          json: false,
          timeoutMs: 90_000,
        }),
        runtime,
      );
    });
  }, 60_000);

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

      const configPath = resolveStateConfigPath(process.env, stateDir);
      const cfg = await readJsonFile<{
        gateway?: {
          bind?: string;
          port?: number;
          auth?: { mode?: string; token?: string };
        };
      }>(configPath);

      expect(cfg.gateway?.bind).toBe("lan");
      expect(cfg.gateway?.port).toBe(port);
      expect(cfg.gateway?.auth?.mode).toBe("token");
      expect((cfg.gateway?.auth?.token ?? "").length).toBeGreaterThan(8);
    });
  }, 60_000);
});
