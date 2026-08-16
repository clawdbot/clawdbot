// Non-interactive gateway onboarding tests cover local/remote setup, auth, daemon install, and config writes.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createThrowingRuntime,
  mockOnboardingAgent,
} from "./onboard-non-interactive.test-helpers.js";
import type { WaitForGatewayReachableMock } from "./onboard-non-interactive.test-helpers.js";
import type { installGatewayDaemonNonInteractive } from "./onboard-non-interactive/local/daemon-install.js";

const ensureWorkspaceAndSessionsMock = vi.fn(async (..._args: unknown[]) => {});
const testConfigStore = new Map<string, OpenClawConfig>();
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn<() => Promise<ConfigFileSnapshot>>());
const pluginLifecycleLeaseState = vi.hoisted(() => ({ depth: 0 }));
const configWritePluginLeaseDepths: number[] = [];
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
let waitForGatewayReachableMock: WaitForGatewayReachableMock;

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

function readTestConfigSnapshot(): ConfigFileSnapshot {
  const config = testConfigStore.get(resolveTestConfigPath()) ?? {};
  const exists = testConfigStore.has(resolveTestConfigPath());
  return {
    path: resolveTestConfigPath(),
    exists,
    raw: exists ? `${JSON.stringify(config, null, 2)}\n` : null,
    parsed: config,
    sourceConfig: config,
    resolved: config,
    valid: true,
    runtimeConfig: config,
    config,
    ...(exists ? { hash: "test-config-hash" } : {}),
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

readConfigFileSnapshotMock.mockImplementation(async () => readTestConfigSnapshot());

vi.mock("../config/io.js", () => ({
  createConfigIO: () => ({
    configPath: resolveTestConfigPath(),
  }),
  loadConfig: () => readTestConfig(),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: {
      databasePath: string;
      signal: AbortSignal;
      assertOwned: () => void;
      assertOwnedInTransaction: () => void;
    }) => Promise<unknown>,
  ) => {
    pluginLifecycleLeaseState.depth += 1;
    try {
      return await run({
        databasePath: path.join(path.dirname(resolveTestConfigPath()), "openclaw.sqlite"),
        signal: new AbortController().signal,
        assertOwned: () => {},
        assertOwnedInTransaction: () => {},
      });
    } finally {
      pluginLifecycleLeaseState.depth -= 1;
    }
  },
}));

const capturedReplaceConfigFileCalls: Array<{
  nextConfig: OpenClawConfig;
  writeOptions?: { allowConfigSizeDrop?: boolean; unsetPaths?: string[][] };
}> = [];

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    replaceConfigFile: async ({
      nextConfig,
      writeOptions,
    }: {
      nextConfig: OpenClawConfig;
      writeOptions?: { allowConfigSizeDrop?: boolean; unsetPaths?: string[][] };
    }) => {
      configWritePluginLeaseDepths.push(pluginLifecycleLeaseState.depth);
      capturedReplaceConfigFileCalls.push({
        nextConfig,
        ...(writeOptions ? { writeOptions } : {}),
      });
      testConfigStore.set(resolveTestConfigPath(), nextConfig);
    },
    resolveConfigWriteAfterWrite: actual.resolveConfigWriteAfterWrite,
    resolveGatewayPort: (cfg: OpenClawConfig) => cfg.gateway?.port ?? 18789,
    transformConfigFileWithRetry: async (
      params: Parameters<typeof import("../config/config.js").transformConfigFileWithRetry>[0],
    ) => {
      const snapshot = await readConfigFileSnapshotMock();
      const previousHash = snapshot.hash ?? null;
      const transformed = await params.transform(snapshot.sourceConfig, {
        snapshot,
        previousHash,
        attempt: 0,
      });
      const committed = await params.commit!({
        nextConfig: transformed.nextConfig,
        snapshot,
        ...(previousHash ? { baseHash: previousHash } : {}),
        writeOptions: params.writeOptions,
        afterWrite: { mode: "auto" },
      });
      return { nextConfig: committed.config };
    },
  };
});

vi.mock("./onboard-agent.js", () => ({ ensureOnboardingAgent: mockOnboardingAgent }));

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
    resolveLocalControlUiProbeLinks: ({ port }: { port: number }) => ({
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
let resolveInstallDaemonGatewayHealthTiming: typeof import("./onboard-non-interactive/local.test-support.js").resolveInstallDaemonGatewayHealthTiming;

async function loadGatewayOnboardModules(): Promise<void> {
  vi.resetModules();
  ({ runNonInteractiveSetup } = await import("./onboard-non-interactive.js"));
  ({ resolveInstallDaemonGatewayHealthTiming } =
    await import("./onboard-non-interactive/local.test-support.js"));
}

const getPseudoPort = (base: number): number => base + (process.pid % 1000);

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

type MockWithCalls<TArgs extends unknown[]> = {
  mock: {
    calls: TArgs[];
  };
};

function readFirstMockCall(mock: unknown, label: string): unknown[] {
  const calls = (mock as MockWithCalls<unknown[]>).mock.calls;
  const call = calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

type EnsureWorkspaceOptions = {
  skipBootstrap?: boolean;
};

type GatewayHealthCall = {
  password?: string;
  token?: string;
};

type HealthCommandCall = GatewayHealthCall & {
  config?: OpenClawConfig;
};

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
    const stateDir = await fs.realpath(await fs.mkdtemp(path.join(tempHome, prefix)));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
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
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
    setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
    setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
    setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
    setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");

    tempHome = await makeTempWorkspace("openclaw-onboard-");
    setTestEnvValue("HOME", tempHome);

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
    capturedReplaceConfigFileCalls.length = 0;
    configWritePluginLeaseDepths.length = 0;
    vi.clearAllMocks();
  });

  it("rejects concurrent onboarding runs sharing one state directory", async () => {
    await withStateDir("state-concurrent-onboard-", async (stateDir) => {
      let workspaceSetupCalls = 0;
      let releaseFirstSetup!: () => void;
      const firstSetupEntered = new Promise<void>((resolve) => {
        ensureWorkspaceAndSessionsMock.mockImplementation(async () => {
          workspaceSetupCalls += 1;
          if (workspaceSetupCalls === 1) {
            resolve();
            await new Promise<void>((release) => {
              releaseFirstSetup = release;
            });
          }
        });
      });
      const options = {
        nonInteractive: true,
        mode: "local" as const,
        workspace: path.join(stateDir, "openclaw"),
        authChoice: "skip" as const,
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
      };

      try {
        const first = runNonInteractiveSetup(options, runtime);
        await firstSetupEntered;
        const readsBeforeSecond = readConfigFileSnapshotMock.mock.calls.length;
        const writesBeforeSecond = capturedReplaceConfigFileCalls.length;
        await expect(runNonInteractiveSetup(options, runtime)).rejects.toMatchObject({
          name: "SetupTargetLockedError",
          code: "setup_target_locked",
          holderPid: process.pid,
        });

        expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(readsBeforeSecond);
        expect(capturedReplaceConfigFileCalls).toHaveLength(writesBeforeSecond);
        expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledOnce();

        releaseFirstSetup();
        await first;
        await runNonInteractiveSetup(options, runtime);
        expect(configWritePluginLeaseDepths).toHaveLength(2);
        expect(configWritePluginLeaseDepths.every((depth) => depth > 0)).toBe(true);
      } finally {
        releaseFirstSetup?.();
        ensureWorkspaceAndSessionsMock.mockImplementation(async () => {});
      }
    });
  });

  it("writes the implicit workspace under a non-default state directory", async () => {
    await withStateDir("state-isolated-workspace-", async (stateDir) => {
      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayBind: "loopback",
          gatewayAuth: "token",
          gatewayToken: "tok_state_isolation",
        },
        runtime,
      );

      const workspace = path.join(stateDir, "workspace");
      const cfg = readTestConfig();
      expect(cfg.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg.agents?.entries?.main?.workspace).toBe(workspace);
    });
  });

  it("preserves existing config on onboard rerun (openclaw#84692)", async () => {
    await withStateDir("state-preserve-agents-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");
      const warningRuntime = { ...runtime, error: vi.fn() };
      const passwordRef = { source: "env" as const, provider: "default", id: "GATEWAY_PASSWORD" };
      const seededAgents = [
        { id: "alpha", default: true, model: "anthropic/claude-3-5-sonnet" },
        { id: "beta", model: "openai/gpt-4o" },
      ];
      const seededBindings = [
        {
          type: "route" as const,
          agentId: "alpha",
          match: {
            channel: "discord",
            peer: { kind: "direct" as const, id: "user-1" },
          },
        },
        {
          type: "route" as const,
          agentId: "beta",
          match: {
            channel: "discord",
            peer: { kind: "direct" as const, id: "user-2" },
          },
        },
      ];
      testConfigStore.set(resolveTestConfigPath(), {
        agents: { list: seededAgents, defaults: { workspace } },
        bindings: seededBindings,
        gateway: {
          mode: "local",
          port: 24680,
          bind: "loopback",
          auth: { mode: "password", password: passwordRef },
          tailscale: { mode: "serve", resetOnExit: true },
        },
      } as OpenClawConfig);

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace: path.join(stateDir, "requested-workspace"),
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
        },
        warningRuntime,
      );

      const cfg = readTestConfig();
      expect(cfg.agents?.list?.map((a) => a.id)).toEqual(["alpha", "beta"]);
      expect(cfg.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg.bindings).toEqual(seededBindings);
      expect(warningRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("existing agents keep their current workspace"),
      );
      expect(cfg.gateway?.port).toBe(24680);

      const onboardWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(onboardWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  it("migrates local onboard plugin install records in the setup write", async () => {
    await withStateDir("state-local-plugin-installs-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");
      testConfigStore.set(resolveTestConfigPath(), {
        plugins: {
          installs: {
            demo: {
              source: "path",
              installPath: path.join(stateDir, "plugins", "demo"),
            },
          },
        },
      } as OpenClawConfig);

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
          gatewayToken: "tok_plugin_installs",
        },
        runtime,
      );

      expect(capturedReplaceConfigFileCalls).toHaveLength(1);
      const onboardWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(onboardWrite?.nextConfig.plugins?.installs).toBeUndefined();
      expect(onboardWrite?.writeOptions?.unsetPaths).toEqual([["plugins", "installs"]]);
      expect(onboardWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  it("writes gateway token auth into config", async () => {
    await withStateDir("state-noninteractive-", async (stateDir) => {
      const token = "tok_test_123";
      const workspace = path.join(stateDir, "openclaw");
      testConfigStore.set(resolveTestConfigPath(), {
        gateway: {
          bind: "lan",
          auth: { mode: "password", password: "test-password" },
          tailscale: { mode: "serve", resetOnExit: true },
        },
      } as OpenClawConfig);

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
          tailscale: "off",
          tailscaleResetOnExit: false,
        },
        runtime,
      );

      const cfg = readTestConfig<{
        gateway?: {
          mode?: string;
          bind?: string;
          auth?: { mode?: string; token?: string };
          tailscale?: { mode?: string; resetOnExit?: boolean };
        };
        agents?: { defaults?: { workspace?: string } };
        tools?: { profile?: string };
        hooks?: { internal?: { entries?: Record<string, { enabled?: boolean }> } };
      }>();

      expect(cfg?.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg?.gateway?.mode).toBe("local");
      expect(cfg?.gateway?.bind).toBe("loopback");
      expect(cfg?.tools?.profile).toBe("coding");
      expect(cfg?.gateway?.auth?.mode).toBe("token");
      expect(cfg?.gateway?.auth?.token).toBe(token);
      expect(cfg?.gateway?.tailscale).toEqual({ mode: "off", resetOnExit: false });
      expect(cfg?.hooks?.internal?.entries?.["session-memory"]).toEqual({ enabled: true });
    });
  }, 60_000);

  it("does not auto-enable default hooks when skipHooks is set", async () => {
    await withStateDir("state-skip-hooks-", async (stateDir) => {
      const workspace = path.join(stateDir, "openclaw");
      testConfigStore.set(resolveTestConfigPath(), {
        gateway: { mode: "local", bind: "lan" },
      } as OpenClawConfig);

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace,
          authChoice: "skip",
          skipHooks: true,
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
        },
        runtime,
      );

      const cfg = readTestConfig();
      expect(cfg.hooks).toBeUndefined();
      expect(cfg.gateway?.bind).toBe("lan");
    });
  }, 60_000);

  it("persists skipBootstrap and skips workspace bootstrap creation", async () => {
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
      expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledOnce();
      const [workspaceArg, runtimeArg, optionsArg] = readFirstMockCall(
        ensureWorkspaceAndSessionsMock,
        "ensureWorkspaceAndSessions",
      ) as [string, RuntimeEnv, EnsureWorkspaceOptions];
      expect(workspaceArg).toBe(workspace);
      expect(runtimeArg).toBe(runtime);
      expect(optionsArg.skipBootstrap).toBe(true);
    });
  }, 60_000);

  it("writes gateway.remote url/token", async () => {
    await withStateDir("state-remote-", async (_stateDir) => {
      const port = getPseudoPort(30_000);
      const token = "tok_remote_123";
      testConfigStore.set(resolveTestConfigPath(), {
        gateway: {
          remote: {
            url: "wss://old.example.test",
            transport: "ssh",
            remotePort: 24680,
            sshTarget: "operator@old.example.test",
            sshIdentity: "/tmp/old-identity",
            sshHostKeyPolicy: "openssh",
            token: "test-token",
            password: { source: "env", provider: "default", id: "REMOTE_PASSWORD" },
            tlsFingerprint: "sha256:test-fingerprint",
          },
        },
      } as OpenClawConfig);
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

      const cfg = readTestConfig();

      expect(cfg.gateway?.mode).toBe("remote");
      expect(cfg.gateway?.remote).toEqual({
        url: `ws://127.0.0.1:${port}`,
        token,
      });
      expect(cfg.hooks?.internal?.entries?.["session-memory"]).toEqual({ enabled: true });
    });
  }, 60_000);

  it("preserves existing agents.list and bindings on remote onboard rerun (openclaw#84692)", async () => {
    await withStateDir("state-remote-preserve-agents-", async (_stateDir) => {
      const port = getPseudoPort(30_000);
      const passwordRef = {
        source: "env" as const,
        provider: "default",
        id: "OPENCLAW_REMOTE_GATEWAY_PASSWORD",
      };
      const tokenRef = { source: "env" as const, provider: "default", id: "REMOTE_TOKEN" };
      const seededAgents = [
        { id: "alpha", model: "anthropic/claude-3-5-sonnet" },
        { id: "beta", model: "openai/gpt-4o" },
      ];
      const seededBindings = [
        {
          type: "route" as const,
          agentId: "alpha",
          match: {
            channel: "discord",
            peer: { kind: "direct" as const, id: "user-1" },
          },
        },
      ];
      testConfigStore.set(resolveTestConfigPath(), {
        agents: { list: seededAgents },
        bindings: seededBindings,
        gateway: {
          mode: "remote",
          remote: {
            url: `ws://127.0.0.1:${port}`,
            token: tokenRef,
            password: passwordRef,
            tlsFingerprint: "sha256:test-fingerprint",
          },
        },
      } as OpenClawConfig);

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: `ws://127.0.0.1:${port}`,
          authChoice: "skip",
          json: true,
        },
        runtime,
      );

      const cfg = readTestConfig();
      expect(cfg.agents?.list?.map((a) => a.id)).toEqual(["alpha", "beta"]);
      expect(cfg.bindings).toEqual(seededBindings);
      expect(cfg.gateway?.remote).toEqual({
        url: `ws://127.0.0.1:${port}`,
        token: tokenRef,
        password: passwordRef,
        tlsFingerprint: "sha256:test-fingerprint",
      });

      const remoteWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(remoteWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  it("migrates remote onboard plugin install records in the setup write", async () => {
    await withStateDir("state-remote-plugin-installs-", async (stateDir) => {
      const port = getPseudoPort(30_000);
      const token = "tok_remote_seed";
      testConfigStore.set(resolveTestConfigPath(), {
        plugins: {
          installs: {
            demo: {
              source: "path",
              installPath: path.join(stateDir, "plugins", "demo"),
            },
          },
        },
        gateway: {
          mode: "remote",
          remote: { url: `ws://127.0.0.1:${port}`, token },
        },
      } as OpenClawConfig);

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

      expect(capturedReplaceConfigFileCalls).toHaveLength(1);
      const remoteWrite = capturedReplaceConfigFileCalls.at(-1);
      expect(remoteWrite?.nextConfig.plugins?.installs).toBeUndefined();
      expect(remoteWrite?.writeOptions?.unsetPaths).toEqual([["plugins", "installs"]]);
      expect(remoteWrite?.writeOptions?.allowConfigSizeDrop).toBe(false);
    });
  }, 60_000);

  it("completes explicit no-daemon setup when no gateway is listening", async () => {
    await withStateDir("state-local-health-hint-", async (stateDir) => {
      waitForGatewayReachableMock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      const log = vi.fn();

      await runNonInteractiveSetup(
        { ...createLocalDaemonSetupOptions(stateDir), installDaemon: false },
        { ...runtime, log },
      );

      expect(log.mock.calls.flat().join("\n")).toMatch(
        /Setup complete; gateway was not installed or started because daemon installation was explicitly skipped\.[\s\S]*Gateway did not become reachable[\s\S]*Classification: not-listening[\s\S]*only waits for an already-running gateway unless you pass `--install-daemon` to `openclaw onboard`[\s\S]*openclaw onboard --install-daemon[\s\S]*openclaw onboard --skip-health/,
      );
    });
  }, 60_000);

  it("still fails when an existing gateway is expected but unreachable", async () => {
    await withStateDir("state-local-health-required-", async (stateDir) => {
      waitForGatewayReachableMock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));

      await expect(
        runNonInteractiveSetup(
          { ...createLocalDaemonSetupOptions(stateDir), installDaemon: undefined },
          runtime,
        ),
      ).rejects.toThrow(
        /Gateway did not become reachable[\s\S]*Classification: not-listening[\s\S]*openclaw onboard --install-daemon[\s\S]*openclaw onboard --skip-health/,
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

      const [gatewayHealthCall] = readFirstMockCall(
        waitForGatewayReachableMock,
        "waitForGatewayReachable",
      ) as [GatewayHealthCall];
      expect(gatewayHealthCall.token).toBe(token);
      expect(gatewayHealthCall.password).toBeUndefined();
      const [healthCall, healthRuntime] = readFirstMockCall(healthCommandMock, "healthCommand") as [
        HealthCommandCall,
        RuntimeEnv,
      ];
      expect(healthCall.token).toBe(token);
      expect(healthCall.password).toBeUndefined();
      expect(healthCall.config?.gateway?.auth?.mode).toBe("token");
      expect(healthCall.config?.gateway?.auth?.token).toBe(token);
      expect(healthRuntime).toBe(runtime);
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
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));

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
