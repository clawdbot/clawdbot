// Non-interactive gateway onboarding tests cover local/remote setup, daemon install, and config writes.
// Gateway auth-token storage has its own suite in onboard-non-interactive.gateway-auth-token.test.ts.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { setTestEnvValue, withEnv, withEnvAsync } from "../test-utils/env.js";
import {
  capturedReplaceConfigFileCalls,
  configWritePluginLeaseDepths,
  ensureWorkspaceAndSessionsMock,
  gatewayReachableState,
  gatewayServiceMock,
  getPseudoPort,
  healthCommandMock,
  installGatewayDaemonNonInteractiveMock,
  loadGatewayOnboardModules,
  gatewayOnboardConfigSnapshotMock as readConfigFileSnapshotMock,
  readLastGatewayErrorLineMock,
  readTestConfig,
  resolveInstallDaemonGatewayHealthTiming,
  resolveTestConfigPath,
  runNonInteractiveSetup,
  gatewayOnboardRuntime as runtime,
  testConfigStore,
} from "./onboard-non-interactive.gateway.test-mocks.js";
import {
  createOnboardGatewayTimeoutCapture,
  createOnboardJsonCaptureRuntime,
  createOnboardLocalDaemonOptions,
  createOnboardStateDirHarness,
  expectOnboardLocalJsonSetupFailure,
  prepareOnboardGatewayTestEnv,
  readOnboardFirstMockCall,
  runOnboardLocalDaemonSetup,
} from "./onboard-non-interactive.test-helpers.js";
import type {
  OnboardEnsureWorkspaceOptions,
  OnboardGatewayHealthCall,
  OnboardHealthCommandCall,
} from "./onboard-non-interactive.test-helpers.js";
import { logNonInteractiveOnboardingFailure } from "./onboard-non-interactive/local/output.js";

describe("logNonInteractiveOnboardingFailure", () => {
  const callerFix = "Fix: use the phase-specific recovery path.";
  const failure = {
    mode: "local" as const,
    phase: "gateway-health",
    message: "Gateway did not become reachable.",
    detail: "connect ECONNREFUSED 127.0.0.1:18997",
    hints: ["Phase-specific context.", callerFix],
  };

  it("uses a caller-supplied Fix hint in human and JSON output", () => {
    const error = vi.fn();
    logNonInteractiveOnboardingFailure({
      ...failure,
      opts: {},
      runtime: { ...runtime, error },
    });

    const humanLines = String(error.mock.calls[0]?.[0]).split("\n");
    expect(humanLines.filter((line) => line.startsWith("Fix:"))).toEqual([callerFix]);

    const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
    logNonInteractiveOnboardingFailure({
      ...failure,
      opts: { json: true },
      runtime: runtimeWithCapture,
    });

    const parsed = JSON.parse(readCapturedJson()) as { hints: string[] };
    expect(parsed.hints.filter((hint) => hint.startsWith("Fix:"))).toEqual([callerFix]);
  });

  it("keeps the classification recovery hint when the caller supplies no hints", () => {
    const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
    logNonInteractiveOnboardingFailure({
      ...failure,
      hints: undefined,
      opts: { json: true },
      runtime: runtimeWithCapture,
    });

    const parsed = JSON.parse(readCapturedJson()) as { hints: string[] };
    expect(parsed.hints).toEqual([
      "Fix: start `openclaw gateway run`, or run `openclaw gateway restart` for a managed gateway.",
    ]);
  });

  it.each([
    {
      name: "active profile",
      env: { OPENCLAW_PROFILE: "work", OPENCLAW_CONTAINER_HINT: undefined },
      selector: "--profile work",
    },
    {
      name: "container precedence over the active profile",
      env: { OPENCLAW_PROFILE: "work", OPENCLAW_CONTAINER_HINT: "preview" },
      selector: "--container preview",
    },
  ])("keeps $name on every recovery command in human and JSON output", ({ env, selector }) => {
    const cases = [
      {
        detail: "unauthorized: invalid token",
        commands: ["doctor --fix"],
      },
      {
        detail: "Cannot find module sqlite-vec",
        commands: ["doctor --fix"],
      },
      {
        detail: "Cannot find package 'typebox' imported from /app/plugin.mjs",
        commands: ["doctor --fix"],
      },
      {
        detail: "ERR_MODULE_NOT_FOUND",
        commands: ["doctor --fix"],
      },
      {
        detail: "connect ECONNREFUSED",
        diagnostics: {
          lastGatewayError: "Cannot find package '@openclaw/example' imported from /app/plugin.mjs",
        },
        commands: ["doctor --fix"],
      },
      {
        detail: "connect ECONNREFUSED",
        diagnostics: {
          service: {
            label: "Gateway",
            loaded: false,
            loadState: { status: "not-loaded" as const },
            loadedText: "not loaded",
          },
        },
        commands: ["gateway install --force"],
      },
      {
        detail: "connect ECONNREFUSED",
        diagnostics: {
          service: {
            label: "Gateway",
            loaded: true,
            loadState: { status: "loaded" as const },
            loadedText: "loaded",
            runtimeStatus: "stopped",
          },
        },
        commands: ["gateway restart"],
      },
      {
        detail: "startup timed out",
        diagnostics: { lastGatewayError: "configuration parse failed" },
        commands: ["gateway status --deep"],
      },
      {
        detail: "connect ECONNREFUSED",
        commands: ["gateway run", "gateway restart"],
      },
    ];

    withEnv(env, () => {
      for (const { detail, diagnostics, commands } of cases) {
        for (const json of [false, true]) {
          const output = vi.fn();
          logNonInteractiveOnboardingFailure({
            ...failure,
            hints: undefined,
            opts: { json },
            runtime: { ...runtime, log: output, error: output },
            detail,
            diagnostics,
          });

          const emitted = String(output.mock.calls[0]?.[0]);
          const hint = json
            ? (JSON.parse(emitted) as { hints: string[] }).hints[0]
            : emitted.split("\n").find((line) => line.startsWith("Fix:"));
          for (const command of commands) {
            expect(hint).toContain(`\`openclaw ${selector} ${command}\``);
          }
        }
      }
    });
  });

  it("leaves hints for a non-gateway-health phase unchanged", () => {
    const hints = [callerFix, "Keep the configured environment available."];
    const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
    logNonInteractiveOnboardingFailure({
      opts: { json: true },
      runtime: runtimeWithCapture,
      mode: "local",
      phase: "daemon-install",
      message: "Gateway service install did not complete successfully.",
      hints,
    });

    const parsed = JSON.parse(readCapturedJson()) as { classification?: string; hints: string[] };
    expect(parsed.classification).toBeUndefined();
    expect(parsed.hints).toEqual(hints);
  });
});

describe("onboard (non-interactive): gateway and remote auth", () => {
  let envSnapshot: ReturnType<typeof prepareOnboardGatewayTestEnv>;
  let tempHome: string | undefined;
  const { withStateDir } = createOnboardStateDirHarness(() => tempHome);
  beforeAll(async () => {
    envSnapshot = prepareOnboardGatewayTestEnv();

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

  afterEach(async () => {
    gatewayReachableState.mock = undefined;
    const { resetSecretRedactionRegistryForTest } =
      await import("../logging/secret-redaction-registry.test-support.js");
    resetSecretRedactionRegistryForTest();
    testConfigStore.clear();
    capturedReplaceConfigFileCalls.length = 0;
    configWritePluginLeaseDepths.length = 0;
    vi.clearAllMocks();
  });

  it.each([false, true])(
    "rejects invalid existing config without writes while honoring JSON output (json: %s)",
    async (json) => {
      await withStateDir("state-invalid-config-", async (stateDir) => {
        const snapshot = await readConfigFileSnapshotMock();
        readConfigFileSnapshotMock.mockResolvedValueOnce({
          ...snapshot,
          exists: true,
          valid: false,
          issues: [{ path: "gateway.port", message: "invalid" }],
        });
        const output = vi.fn();
        const error = vi.fn();
        const captureRuntime: RuntimeEnv = {
          log: output,
          error,
          exit: (code) => {
            throw new Error(`exit:${code}`);
          },
        };
        const message = "Config invalid. Run `openclaw doctor` to repair it, then re-run setup.";

        await expect(
          runNonInteractiveSetup(
            {
              ...createOnboardLocalDaemonOptions(stateDir),
              installDaemon: false,
              skipHealth: true,
              json,
            },
            captureRuntime,
          ),
        ).rejects.toThrow("exit:1");

        expect(error).toHaveBeenCalledWith(message);
        if (json) {
          expect(output).toHaveBeenCalledOnce();
          expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
            ok: false,
            phase: "options",
            message,
          });
        } else {
          expect(output).not.toHaveBeenCalled();
        }
        expect(capturedReplaceConfigFileCalls).toHaveLength(0);
        expect(ensureWorkspaceAndSessionsMock).not.toHaveBeenCalled();
      });
    },
  );

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
          tailscale: { mode: "serve" },
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
      const [workspaceArg, runtimeArg, optionsArg] = readOnboardFirstMockCall(
        ensureWorkspaceAndSessionsMock,
        "ensureWorkspaceAndSessions",
      ) as [string, RuntimeEnv, OnboardEnsureWorkspaceOptions];
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
      expect(cfg.hooks).toBeUndefined();
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
      const seededHooks = {
        internal: {
          enabled: false,
          entries: { "session-memory": { enabled: false } },
        },
      };
      testConfigStore.set(resolveTestConfigPath(), {
        agents: { list: seededAgents },
        bindings: seededBindings,
        hooks: seededHooks,
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
      expect(cfg.hooks).toEqual(seededHooks);
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
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      const log = vi.fn();

      await runNonInteractiveSetup(
        { ...createOnboardLocalDaemonOptions(stateDir), installDaemon: false },
        { ...runtime, log },
      );

      expect(log.mock.calls.flat().join("\n")).toMatch(
        /Setup complete; gateway was not installed or started because daemon installation was explicitly skipped\.[\s\S]*Gateway did not become reachable[\s\S]*Classification: not-listening[\s\S]*only waits for an already-running gateway unless you pass `--install-daemon` to `openclaw onboard`[\s\S]*openclaw onboard --install-daemon[\s\S]*openclaw onboard --skip-health/,
      );
    });
  }, 60_000);

  it("still fails when an existing gateway is expected but unreachable", async () => {
    await withStateDir("state-local-health-required-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));

      await expect(
        runNonInteractiveSetup(
          { ...createOnboardLocalDaemonOptions(stateDir), installDaemon: undefined },
          runtime,
        ),
      ).rejects.toThrow(
        /Gateway did not become reachable[\s\S]*Classification: not-listening[\s\S]*openclaw onboard --install-daemon[\s\S]*openclaw onboard --skip-health/,
      );
    });
  }, 60_000);

  it("uses a longer health deadline when daemon install was requested", async () => {
    await withStateDir("state-local-daemon-health-", async (stateDir) => {
      const captured = createOnboardGatewayTimeoutCapture();
      gatewayReachableState.mock = captured.mock;

      await runOnboardLocalDaemonSetup({ runSetup: runNonInteractiveSetup, stateDir, runtime });

      const cfg = readTestConfig() as {
        gateway?: { mode?: string; bind?: string };
      };

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
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));

      await runNonInteractiveSetup(
        {
          ...createOnboardLocalDaemonOptions(stateDir),
          gatewayAuth: "token",
          gatewayToken: token,
        },
        runtime,
      );

      const [gatewayHealthCall] = readOnboardFirstMockCall(
        gatewayReachableState.mock,
        "waitForGatewayReachable",
      ) as [OnboardGatewayHealthCall];
      expect(gatewayHealthCall.token).toBe(token);
      expect(gatewayHealthCall.password).toBeUndefined();
      const [healthCall, healthRuntime] = readOnboardFirstMockCall(
        healthCommandMock,
        "healthCommand",
      ) as [OnboardHealthCommandCall, RuntimeEnv];
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

  it.each([false, true])(
    "emits a daemon-install failure when Linux user systemd is unavailable (skipHealth: %s)",
    async (skipHealth) => {
      await withStateDir("state-local-daemon-install-json-fail-", async (stateDir) => {
        installGatewayDaemonNonInteractiveMock.mockResolvedValueOnce({
          installed: false,
          skippedReason: "systemd-user-unavailable",
        });

        const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();

        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "linux",
        });

        try {
          await expectOnboardLocalJsonSetupFailure({
            runSetup: (opts, runtimeEnv) =>
              runNonInteractiveSetup({ ...opts, skipHealth }, runtimeEnv),
            stateDir,
            runtime: runtimeWithCapture,
          });
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
    },
    60_000,
  );

  it("emits structured JSON diagnostics when daemon health fails", async () => {
    await withStateDir("state-local-daemon-health-json-fail-", async (stateDir) => {
      const registeredSecret = "qa-onboarding-health-secret";
      const { registerSecretValueForRedaction } =
        await import("../logging/secret-redaction-registry.js");
      registerSecretValueForRedaction(registeredSecret);
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: `gateway closed (1006 abnormal closure (no close frame)): ${registeredSecret}`,
      }));
      readLastGatewayErrorLineMock.mockResolvedValueOnce(
        `Gateway failed to start: required secrets are unavailable: ${registeredSecret}`,
      );

      const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
      await expectOnboardLocalJsonSetupFailure({
        runSetup: runNonInteractiveSetup,
        stateDir,
        runtime: runtimeWithCapture,
      });

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
            loaded?: boolean | null;
            loadState?: { status?: string };
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
      expect(parsed.diagnostics?.service?.loadState).toEqual({ status: "loaded" });
      expect(parsed.diagnostics?.service?.runtimeStatus).toBe("running");
      expect(parsed.diagnostics?.service?.pid).toBe(4242);
      expect(parsed.diagnostics?.lastGatewayError).toContain("required secrets are unavailable");
      expect(readCapturedJson()).not.toContain(registeredSecret);
    });
  }, 60_000);

  it("emits structured JSON failure when a reachable gateway fails its health check", async () => {
    await withStateDir("state-local-daemon-health-exit-json-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));
      healthCommandMock.mockImplementationOnce(async (...args: unknown[]) => {
        // healthCommand prints its reachable-gateway diagnostic before its
        // CLI-style exit; the capture runtime must keep it off JSON stdout.
        // importActual yields the ExitError instance the prod graph sees; the
        // test file's static import can be a second class instance under Vitest.
        const { ExitError: RuntimeExitError } =
          await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
        const healthRuntime = args[1] as RuntimeEnv;
        healthRuntime.log("Gateway is reachable.");
        healthRuntime.log("Gateway credentials rejected.");
        throw new RuntimeExitError(1);
      });

      const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
      await expectOnboardLocalJsonSetupFailure({
        runSetup: runNonInteractiveSetup,
        stateDir,
        runtime: runtimeWithCapture,
      });

      const parsed = JSON.parse(readCapturedJson()) as {
        ok: boolean;
        phase: string;
        message: string;
        detail?: string;
        hints?: string[];
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.phase).toBe("gateway-health");
      expect(parsed.message).toContain("health check failed");
      expect(parsed.detail).toContain("Gateway credentials rejected.");
      expect(parsed.hints).toContain("Run `openclaw health` for full diagnostics.");
    });
  }, 60_000);

  it("routes thrown health-check errors through the onboarding failure owner", async () => {
    await withStateDir("state-local-health-failure-text-", async (stateDir) => {
      const registeredSecret = "qa-onboarding-health-secret";
      const { registerSecretValueForRedaction } =
        await import("../logging/secret-redaction-registry.js");
      registerSecretValueForRedaction(registeredSecret);
      gatewayReachableState.mock = vi.fn(async () => ({ ok: true }));
      healthCommandMock.mockRejectedValueOnce(
        new Error(`health request timed out: ${registeredSecret}`),
      );

      const failure = await runNonInteractiveSetup(
        createOnboardLocalDaemonOptions(stateDir),
        runtime,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/health check failed[\s\S]*health request timed out/);
      expect(String(failure)).not.toContain(registeredSecret);
    });
  }, 60_000);

  it("preserves unknown service inspection in JSON diagnostics", async () => {
    await withStateDir("state-local-daemon-health-unknown-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      gatewayServiceMock.isLoaded.mockRejectedValueOnce(new Error("systemctl timed out"));

      const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
      await expectOnboardLocalJsonSetupFailure({
        runSetup: runNonInteractiveSetup,
        stateDir,
        runtime: runtimeWithCapture,
      });

      const parsed = JSON.parse(readCapturedJson()) as {
        diagnostics?: {
          service?: { loaded?: boolean | null; loadState?: { status?: string; detail?: string } };
        };
      };
      expect(parsed.diagnostics?.service?.loaded).toBeNull();
      expect(parsed.diagnostics?.service?.loadState).toEqual({
        status: "unknown",
        detail: "Error: systemctl timed out",
      });
    });
  }, 60_000);

  it("classifies daemon health ECONNREFUSED failures with a profile-scoped recovery command", async () => {
    await withStateDir("state-local-daemon-health-refused-", async (stateDir) => {
      gatewayReachableState.mock = vi.fn(async () => ({
        ok: false,
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      }));
      gatewayServiceMock.readRuntime.mockResolvedValueOnce({
        status: "stopped",
        state: "failed",
        pid: 0,
      });
      readLastGatewayErrorLineMock.mockResolvedValueOnce("");

      const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
      await withEnvAsync(
        { OPENCLAW_PROFILE: "work", OPENCLAW_CONTAINER_HINT: undefined },
        async () => {
          await expectOnboardLocalJsonSetupFailure({
            runSetup: runNonInteractiveSetup,
            stateDir,
            runtime: runtimeWithCapture,
          });
        },
      );

      const parsed = JSON.parse(readCapturedJson()) as {
        ok: boolean;
        phase: string;
        classification?: string;
        hints?: string[];
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.phase).toBe("gateway-health");
      expect(parsed.classification).toBe("service-stopped");
      expect(parsed.hints).toContain("Fix: run `openclaw --profile work gateway restart`.");
    });
  }, 60_000);
});
