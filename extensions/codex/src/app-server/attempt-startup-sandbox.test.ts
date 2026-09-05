import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { bundleMcpThreadConfig, createAttemptParams } from "./attempt-startup.test-support.js";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { resolveCodexAppServerRuntimeOptions, resolveCodexComputerUseConfig } from "./config.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import * as sandboxNativeContext from "./sandbox-native-context.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { createCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import { readCodexInheritedMcpServerNames } from "./thread-requests.js";
import { buildTurnStartParams } from "./turn-params.js";

const { prepareCodexSandboxNativeContext } = sandboxNativeContext;

describe("sandboxed Codex native context", () => {
  let root: string;
  beforeEach(async () => {
    resetCodexTestBindingStore();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-context-")));
    await fs.mkdir(path.join(root, "agent"), { mode: 0o700 });
    await fs.mkdir(path.join(root, "workspace"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function prepare(overrides: Partial<Parameters<typeof startCodexAttemptThread>[0]> = {}) {
    const paths = {
      agentDir: path.join(root, "agent"),
      cwd: path.join(root, "workspace"),
      workspaceDir: path.join(root, "workspace"),
      sessionFile: path.join(root, "session.jsonl"),
    };
    const pluginConfig = { appServer: { command: "codex" } };
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig,
      requirementsToml: null,
      env: {},
    });
    const factory = vi.fn<CodexAppServerClientFactory>(async () => {
      throw new Error("captured startup options");
    });
    const sandbox = {
      ...createSandboxContext({}),
      workspaceDir: paths.workspaceDir,
      agentWorkspaceDir: paths.workspaceDir,
    };
    const params: Parameters<typeof startCodexAttemptThread>[0] = {
      attemptClientFactory: factory,
      bindingStore: testCodexAppServerBindingStore,
      appServer: { ...appServer, sandbox: "workspace-write" },
      pluginConfig,
      computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig }),
      startupAuthProfileId: null,
      startupAuthBindingFingerprint: undefined,
      startupAuthAccountCacheKey: undefined,
      startupEnvApiKeyCacheKey: undefined,
      agentDir: paths.agentDir,
      config: undefined,
      buildAttemptParams: () => ({
        ...createAttemptParams(paths),
        pluginHarnessToolPolicyRestricted: true,
      }),
      sessionAgentId: "agent-1",
      effectiveWorkspace: paths.workspaceDir,
      effectiveCwd: paths.cwd,
      dynamicTools: [],
      webSearchAllowed: false,
      developerInstructions: undefined,
      bundleMcpThreadConfig,
      nativeToolSurfaceEnabled: false,
      nativeProviderWebSearchSupport: "supported",
      sandboxExecServerEnabled: false,
      sandbox,
      contextEngineProjection: undefined,
      startupTimeoutMs: 5000,
      signal: new AbortController().signal,
      onStartupTimeout: vi.fn(),
      spawnedBy: undefined,
      ...overrides,
    };
    return { params, factory };
  }

  it.each(
    (["timeout", "timeout-aborts-run", "abort", "revoked"] as const).flatMap((reason) =>
      (["workspace", "hooks"] as const).map((stage) => ({ reason, stage })),
    ),
  )(
    "settles $reason during $stage preparation without late writes or client acquisition",
    async ({ reason, stage }) => {
      const controller = new AbortController();
      let revoked = false;
      const revokedError = new Error("startup owner revoked");
      const onStartupTimeout = vi.fn(() => {
        if (reason === "timeout-aborts-run") {
          controller.abort("codex_startup_timeout");
        }
      });
      const { params, factory } = prepare({
        signal: controller.signal,
        startupTimeoutMs: 100,
        onStartupTimeout,
        assertCurrent: () => {
          if (revoked) {
            throw revokedError;
          }
        },
      });
      const nativeHome = path.join(params.agentDir, "codex-home");
      await fs.mkdir(nativeHome, { mode: 0o700 });
      const hooksPath = path.join(nativeHome, "hooks.json");
      await fs.writeFile(hooksPath, "{}", { mode: 0o600 });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const mkdir = vi.spyOn(fs, "mkdir");
      const realpath = fs.realpath;
      vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        const resolved = await realpath(...args);
        if (stage === "workspace" && String(args[0]) === params.effectiveWorkspace) {
          entered.resolve();
          await release.promise;
        }
        return resolved;
      });
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (stage === "hooks" && String(args[0]) === hooksPath) {
          entered.resolve();
          await release.promise;
        }
        return stat;
      });
      let preparation: ReturnType<typeof prepareCodexSandboxNativeContext> | undefined;
      vi.spyOn(sandboxNativeContext, "prepareCodexSandboxNativeContext").mockImplementation(
        (input) => {
          preparation = prepareCodexSandboxNativeContext(input);
          return preparation;
        },
      );
      vi.useFakeTimers();
      const settled = vi.fn();
      const run = startCodexAttemptThread(params).then(settled, settled);
      let writesBeforeRelease = 0;
      try {
        await entered.promise;
        writesBeforeRelease = mkdir.mock.calls.length;
        expect(settled).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
        if (reason === "abort") {
          controller.abort("cancelled");
        }
        if (reason === "revoked") {
          revoked = true;
        } else {
          await vi.advanceTimersByTimeAsync(100);
          expect(settled).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              code: "CODEX_APP_SERVER_STARTUP_CANCELLED",
              reason: reason === "abort" ? "aborted" : "timed_out",
            }),
          );
        }
      } finally {
        release.resolve();
        await preparation?.catch(() => undefined);
        await run;
        await vi.advanceTimersByTimeAsync(100);
        vi.useRealTimers();
      }
      expect(mkdir).toHaveBeenCalledTimes(writesBeforeRelease);
      expect(factory).not.toHaveBeenCalled();
      expect(settled).toHaveBeenCalledTimes(1);
      expect(onStartupTimeout).toHaveBeenCalledTimes(reason.startsWith("timeout") ? 1 : 0);
      if (reason === "revoked") {
        expect(settled).toHaveBeenCalledWith(revokedError);
      }
    },
  );

  function useWindowsMetadata(target: "directories" | "files" | "all" = "all") {
    vi.stubGlobal(
      "process",
      Object.defineProperty(
        Object.assign(Object.create(process), { geteuid: undefined, getuid: undefined }),
        "platform",
        { value: "win32" },
      ),
    );
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      stat.uid = 0;
      if (target === "all" || (target === "directories" ? stat.isDirectory() : stat.isFile())) {
        // Node's Windows permission bits describe the read-only attribute, not ACL grants.
        stat.mode = (Number(stat.mode) & ~0o777) | 0o666;
      }
      return stat;
    });
  }

  it.each([
    { access: "none", bind: false },
    { access: "ro", bind: false },
    { access: "rw", bind: false },
    { access: "none", bind: true },
  ] as const)(
    "checks original workspace exposure for $access with writable bind=$bind",
    async ({ access, bind }) => {
      const { params, factory } = prepare();
      params.sandbox!.workspaceAccess = access;
      params.sandbox!.agentWorkspaceDir = params.agentDir;
      if (bind) {
        useWindowsMetadata();
        params.sandbox!.docker.binds = [`${params.agentDir}:/original:rw`];
      }
      await expect(startCodexAttemptThread(params)).rejects.toThrow(
        access === "none" && !bind
          ? "captured startup options"
          : /overlaps a model-accessible workspace/u,
      );
      expect(factory).toHaveBeenCalledTimes(access === "none" && !bind ? 1 : 0);
    },
  );

  it("protects native process configuration before acquiring a client while preserving the tool workspace", async () => {
    const { params, factory } = prepare();
    await expect(startCodexAttemptThread(params)).rejects.toThrow("captured startup options");
    const start = factory.mock.calls[0]?.[0]?.startOptions;
    expect(start?.cwd).toBe(path.join(root, "workspace"));
    expect(start?.args).toContain("project_root_markers=[]");
    expect(start?.args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
    expect(start?.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(params.effectiveWorkspace).toBe(path.join(root, "workspace"));
    expect(params.appServer.start.cwd).toBeUndefined();
    expect(start?.env?.CODEX_HOME).toBeUndefined();
    expect(start?.args).toContain(
      `projects={${JSON.stringify(params.effectiveWorkspace)}={trust_level="untrusted"}}`,
    );
  });

  it.each(
    (
      [
        ["workspace-write", "rw", "workspaceWrite"],
        ["read-only", "rw", "readOnly"],
        ["workspace-write", "ro", "readOnly"],
        ["workspace-write", "none", "readOnly"],
      ] as const
    ).flatMap(([mode, access, expectedType]) =>
      (["agent", "user"] as const).map((homeScope) => ({
        mode,
        access,
        expectedType,
        homeScope,
      })),
    ),
  )(
    "keeps $mode/$access authority in $homeScope home across thread startup, context restart and turn requests",
    async ({ mode, access, expectedType, homeScope }) => {
      const { params } = prepare();
      params.appServer.sandbox = mode;
      params.appServer.sessionRoot = params.effectiveWorkspace;
      params.sandbox!.workspaceAccess = access;
      const nativeHome = path.join(root, homeScope === "user" ? "native-home" : "agent/codex-home");
      await fs.mkdir(nativeHome, { mode: 0o700 });
      await fs.writeFile(path.join(nativeHome, "config.toml"), "", { mode: 0o600 });
      await fs.writeFile(path.join(nativeHome, "hooks.json"), "{}", { mode: 0o600 });
      params.appServer.start.homeScope = homeScope;
      params.appServer.start.env = { CODEX_HOME: nativeHome };
      let starts = 0;
      const requests: Array<{ method: string; params: unknown }> = [];
      const harness = createCodexLifecycleHarness({
        respond: (method, request) => {
          requests.push({ method, params: request });
          if (method === "config/read") {
            return {
              config: {
                project_root_markers: [],
                projects: { [params.effectiveWorkspace]: { trust_level: "untrusted" } },
              },
              layers: [],
            };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "skills/list" || method === "mcpServerStatus/list") {
            return { data: [], nextCursor: null };
          }
          if (method === "thread/start" || method === "thread/resume") {
            return threadStartResult(`protected-${++starts}`, (request as { cwd: string }).cwd);
          }
          throw new Error(`Unexpected native request ${method}`);
        },
      });
      const factory = vi.fn<CodexAppServerClientFactory>(async () => harness.client);
      params.attemptClientFactory = factory;
      const result = await startCodexAttemptThread(params);
      try {
        const executionCwd = path.join(root, "workspace");
        expect(factory.mock.calls[0]?.[0]).toMatchObject({
          authProfileId: null,
          startOptions: {
            homeScope,
            env: { CODEX_HOME: nativeHome },
            protectedLaunchRoots: expect.arrayContaining([executionCwd]),
          },
        });
        expect(result.executionCwd).toBe(executionCwd);
        expect(result.sandboxPolicy?.type).toBe(expectedType);
        expect(result.pluginAppServer.sessionRoot).toBeUndefined();
        const turn = buildTurnStartParams(params.buildAttemptParams(), {
          threadId: result.thread.threadId,
          cwd: result.executionCwd,
          appServer: result.pluginAppServer,
          sandboxPolicy: result.sandboxPolicy,
          environmentSelection: result.environmentSelection,
        });
        expect(turn).toMatchObject({
          cwd: executionCwd,
          environments: [],
          sandboxPolicy: { type: expectedType, networkAccess: false },
        });
        expect(turn).not.toHaveProperty("runtimeWorkspaceRoots");
        if (expectedType === "workspaceWrite") {
          expect(turn.sandboxPolicy).toEqual({
            type: "workspaceWrite",
            writableRoots: [params.effectiveWorkspace],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          });
        }
        result.turnRoute.release();
        await result.restartContextEngineCodexThread();
        for (const request of requests.filter(({ method }) =>
          ["config/read", "thread/start", "thread/resume"].includes(method),
        )) {
          expect(request.params).toMatchObject({ cwd: executionCwd });
          if (request.method !== "config/read") {
            expect(request.params).toMatchObject({
              config: {
                project_root_markers: [],
                projects: { [executionCwd]: { trust_level: "untrusted" } },
                "features.shell_tool": false,
                "features.code_mode": false,
              },
              environments: [],
            });
            expect(request.params).not.toHaveProperty("runtimeWorkspaceRoots");
          }
        }
        expect(params.effectiveWorkspace).toBe(path.join(root, "workspace"));
      } finally {
        result.turnRoute.release();
        result.releaseSharedClientLease();
        await harness.client.closeAndWait();
      }
    },
  );

  it.each([
    "workspace",
    "bind",
    "shadowed-bind",
    "permissions",
    "ancestor-bind",
    "shadowed-ancestor-bind",
    "permission-profile",
    "remote",
    "unix",
    "proxy",
    "user-home-bind",
    "user-home-ancestor-bind",
    "user-home-permissions",
  ] as const)(
    "rejects an unsafe native context (%s) before acquiring any client",
    async (scenario) => {
      const { params, factory } = prepare();
      if (scenario === "workspace") {
        params.agentDir = path.join(params.effectiveWorkspace, "agent");
      } else if (scenario === "bind" || scenario === "shadowed-bind") {
        params.sandbox!.docker.binds = [
          `${root}:/shared:rw`,
          ...(scenario === "shadowed-bind" ? [`${path.join(root, "workspace")}:/readonly:ro`] : []),
        ];
      } else if (scenario === "permission-profile") {
        params.appServer.networkProxy = {} as NonNullable<typeof params.appServer.networkProxy>;
      } else if (scenario === "remote") {
        params.appServer.start.transport = "websocket";
        params.appServer.connectionClass = "remote";
      } else if (scenario === "unix") {
        params.appServer.start.transport = "unix";
        params.appServer.start.homeScope = "user";
      } else if (scenario === "proxy") {
        params.appServer.start.args = ["app-server", "proxy"];
      } else if (scenario.startsWith("user-home-")) {
        const nativeParent = path.join(root, "native");
        const nativeHome = path.join(nativeParent, "home");
        await fs.mkdir(nativeHome, { recursive: true, mode: 0o700 });
        params.appServer.start.homeScope = "user";
        params.appServer.start.env = { CODEX_HOME: nativeHome };
        if (scenario === "user-home-permissions") {
          await fs.chmod(nativeHome, 0o770);
        } else {
          const bindRoot = scenario === "user-home-bind" ? nativeHome : nativeParent;
          params.sandbox!.docker.binds = [`${bindRoot}:/native:rw`];
        }
      } else if (scenario === "ancestor-bind" || scenario === "shadowed-ancestor-bind") {
        const parent = params.effectiveWorkspace;
        params.effectiveWorkspace = path.join(parent, "nested");
        await fs.mkdir(params.effectiveWorkspace);
        params.sandbox!.workspaceDir = params.effectiveWorkspace;
        params.sandbox!.agentWorkspaceDir = params.effectiveWorkspace;
        params.sandbox!.docker.binds = [
          `${parent}:/shared:rw`,
          ...(scenario === "shadowed-ancestor-bind"
            ? [`${params.effectiveWorkspace}:/readonly:ro`]
            : []),
        ];
      } else {
        await fs.chmod(params.agentDir, 0o777);
      }
      await expect(startCodexAttemptThread(params)).rejects.toThrow(/Sandboxed Codex/u);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("pins a protected native user home reached through a model-writable alias", async () => {
    const { params, factory } = prepare();
    const nativeHome = path.join(root, "native-home");
    const alias = path.join(params.effectiveWorkspace, "native-alias");
    await fs.mkdir(nativeHome, { mode: 0o700 });
    await fs.symlink(nativeHome, alias);
    params.appServer.start.homeScope = "user";
    params.appServer.start.env = { CODEX_HOME: alias };
    await expect(startCodexAttemptThread(params)).rejects.toThrow("captured startup options");
    expect(factory.mock.calls[0]?.[0]?.startOptions).toMatchObject({
      homeScope: "user",
      env: { CODEX_HOME: nativeHome },
    });
    expect(params.appServer.start.env.CODEX_HOME).toBe(alias);
  });

  it.each(
    ["config.toml", "hooks.json"].flatMap((file) =>
      ["symlink", "hardlink", "writable"].flatMap((kind) =>
        (kind === "writable" ? [false] : [false, true]).map((windows) => ({ file, kind, windows })),
      ),
    ),
  )(
    "rejects a $kind native $file source before client acquisition (Windows=$windows)",
    async ({ file, kind, windows }) => {
      const { params, factory } = prepare();
      const nativeHome = path.join(root, "native-home");
      await fs.mkdir(nativeHome, { mode: 0o700 });
      params.appServer.start.homeScope = "user";
      params.appServer.start.env = { CODEX_HOME: nativeHome };
      const sourcePath = path.join(nativeHome, file);
      if (windows) {
        useWindowsMetadata();
      }
      if (kind === "symlink" || kind === "hardlink") {
        const target = path.join(params.effectiveWorkspace, file);
        await fs.writeFile(target, "");
        if (kind === "symlink") {
          await fs.symlink(target, sourcePath);
        } else {
          await fs.link(target, sourcePath);
        }
      } else {
        await fs.writeFile(sourcePath, "");
        await fs.chmod(sourcePath, 0o660);
      }
      await expect(startCodexAttemptThread(params)).rejects.toThrow(
        /native config and hook sources/u,
      );
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("checks the actual default home's config after an alias retarget during resolution", async () => {
    const { params, factory } = prepare();
    const nativeHome = path.join(params.agentDir, "codex-home");
    await fs.mkdir(nativeHome, { mode: 0o700 });
    const unsafeConfig = path.join(params.effectiveWorkspace, "config.toml");
    await fs.writeFile(unsafeConfig, "");
    await fs.symlink(unsafeConfig, path.join(nativeHome, "config.toml"));
    const alias = path.join(params.effectiveWorkspace, "state-alias");
    await fs.symlink(root, alias);
    params.agentDir = path.join(alias, "agent");
    let swapped = false;
    const realpath = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const resolved = await realpath(...args);
      if (!swapped && String(args[0]) === params.agentDir) {
        swapped = true;
        await fs.unlink(alias);
        await fs.symlink(nativeHome, alias);
      }
      return resolved;
    });
    await expect(startCodexAttemptThread(params)).rejects.toThrow(
      /native config and hook sources/u,
    );
    expect(swapped).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["foreign-owner", "writable"])(
    "checks the canonical target's %s metadata after alias retargeting",
    async (kind) => {
      const { params, factory } = prepare();
      const canonicalAgentDir = params.agentDir;
      const nativeHome = path.join(root, "native-home");
      await fs.mkdir(nativeHome, { mode: 0o700 });
      params.appServer.start.homeScope = "user";
      params.appServer.start.env = { CODEX_HOME: nativeHome };
      const alternate = path.join(root, "alternate");
      await fs.mkdir(path.join(alternate, "agent"), { recursive: true });
      const alias = path.join(params.effectiveWorkspace, "state-alias");
      await fs.symlink(root, alias);
      params.agentDir = path.join(alias, "agent");
      const effectiveUid = 48001;
      vi.stubGlobal(
        "process",
        Object.assign(Object.create(process), {
          geteuid: () => effectiveUid,
          getuid: () => effectiveUid,
        }),
      );
      let swapped = false;
      const mkdir = fs.mkdir;
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (!swapped && [canonicalAgentDir, params.agentDir].includes(String(args[0]))) {
          swapped = true;
          await fs.unlink(alias);
          await fs.symlink(alternate, alias);
        }
        return mkdir(...args);
      });
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        stat.uid = effectiveUid;
        if (String(args[0]) === canonicalAgentDir) {
          if (kind === "foreign-owner") {
            stat.uid = effectiveUid + 1;
          } else {
            stat.mode = Number(stat.mode) | 0o022;
          }
        }
        return stat;
      });
      await expect(startCodexAttemptThread(params)).rejects.toThrow(
        /protected agent and native home directories/u,
      );
      expect(swapped).toBe(true);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, " \t "])(
    "pins a final agent-directory alias with default home %j",
    async (home) => {
      const { params, factory } = prepare();
      const canonicalAgentDir = params.agentDir;
      params.appServer.start.env = home === undefined ? undefined : { CODEX_HOME: home };
      const alias = path.join(root, "agent-alias");
      await fs.symlink(canonicalAgentDir, alias);
      params.agentDir = alias;
      await expect(startCodexAttemptThread(params)).rejects.toThrow("captured startup options");
      expect(factory.mock.calls[0]?.[0]?.agentDir).toBe(canonicalAgentDir);
      expect(factory.mock.calls[0]?.[0]?.startOptions?.env?.CODEX_HOME).toBe(home);
    },
  );

  it.each(["model-workspace", "foreign-owned-parent"])(
    "pins default native home before a %s alias can be replaced",
    async (placement) => {
      const { params, factory } = prepare();
      const aliasParent =
        placement === "model-workspace"
          ? params.effectiveWorkspace
          : path.join(root, "foreign-parent");
      await fs.mkdir(aliasParent, { recursive: true });
      const alias = path.join(aliasParent, "state-alias");
      await fs.symlink(root, alias);
      const canonicalAgentDir = params.agentDir;
      params.agentDir = path.join(alias, "agent");
      const attackerState = path.join(root, "attacker-state");
      await fs.mkdir(path.join(attackerState, "agent", "codex-home"), { recursive: true });
      if (placement === "foreign-owned-parent") {
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (String(args[0]) === aliasParent) {
            stat.uid = (process.geteuid?.() ?? process.getuid?.() ?? 48001) + 1;
          }
          return stat;
        });
      }
      let launchedHome: string | undefined;
      factory.mockImplementationOnce(async (options) => {
        await fs.unlink(alias);
        await fs.symlink(attackerState, alias);
        launchedHome = await fs.realpath(
          resolveCodexAppServerLocalHomeDir(options!.startOptions!, options!.agentDir!),
        );
        throw new Error("captured canonical startup");
      });
      await expect(startCodexAttemptThread(params)).rejects.toThrow("captured canonical startup");
      expect(factory.mock.calls[0]?.[0]?.agentDir).toBe(canonicalAgentDir);
      expect(factory.mock.calls[0]?.[0]?.startOptions?.env?.CODEX_HOME).toBeUndefined();
      expect(launchedHome).toBe(path.join(canonicalAgentDir, "codex-home"));
      expect(params.agentDir).toBe(path.join(alias, "agent"));
    },
  );

  it("rejects a linked default native home before client acquisition", async () => {
    const { params, factory } = prepare();
    const actualHome = path.join(params.agentDir, "actual-home");
    await fs.mkdir(actualHome, { mode: 0o700 });
    await fs.symlink(actualHome, path.join(params.agentDir, "codex-home"));
    await expect(startCodexAttemptThread(params)).rejects.toThrow(
      /protected agent and native home directories/u,
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["agent", "native-home", "config.toml", "hooks.json"])(
    "rejects foreign ownership of %s before client acquisition",
    async (target) => {
      const { params, factory } = prepare();
      const nativeHome = path.join(root, "native-home");
      await fs.mkdir(nativeHome, { mode: 0o755 });
      params.appServer.start.homeScope = "user";
      params.appServer.start.env = { CODEX_HOME: nativeHome };
      const sourcePath =
        target.endsWith(".toml") || target.endsWith(".json")
          ? path.join(nativeHome, target)
          : path.join(root, target);
      if (sourcePath.startsWith(`${nativeHome}${path.sep}`)) {
        await fs.writeFile(sourcePath, "", { mode: 0o644 });
      }
      const effectiveUid = 48001;
      vi.stubGlobal(
        "process",
        Object.assign(Object.create(process), {
          geteuid: () => effectiveUid,
          getuid: () => 48002,
        }),
      );
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        stat.uid = String(args[0]) === sourcePath ? 48003 : effectiveUid;
        return stat;
      });
      await expect(startCodexAttemptThread(params)).rejects.toThrow(
        /owned by the gateway account or root/u,
      );
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it.each(["foreign-owner", "writable", "foreign-sticky", "trusted-sticky"])(
    "checks replaceability through a %s parent",
    async (parent) => {
      const { params, factory } = prepare();
      const nativeHome = path.join(root, "native-home");
      await fs.mkdir(nativeHome, { mode: 0o755 });
      params.appServer.start.homeScope = "user";
      params.appServer.start.env = { CODEX_HOME: nativeHome };
      const effectiveUid = 48001;
      vi.stubGlobal(
        "process",
        Object.assign(Object.create(process), {
          geteuid: () => effectiveUid,
          getuid: () => 48002,
        }),
      );
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        stat.uid = effectiveUid;
        if (String(args[0]) === root) {
          stat.uid = parent.startsWith("foreign") ? 48003 : 0;
          stat.mode =
            (Number(stat.mode) & ~0o7777) |
            (parent.endsWith("sticky") ? 0o1777 : parent === "writable" ? 0o777 : 0o755);
        }
        return stat;
      });
      if (parent === "trusted-sticky") {
        await expect(prepareCodexSandboxNativeContext(params)).resolves.toMatchObject({
          cwd: params.effectiveWorkspace,
        });
      } else {
        await expect(startCodexAttemptThread(params)).rejects.toThrow(
          /untrusted or replaceable parent/u,
        );
        expect(factory).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["effective-uid", "root", "no-uid"])("preserves %s owner admission", async (owner) => {
    const { params } = prepare();
    const nativeHome = path.join(root, "native-home");
    await fs.mkdir(nativeHome, { mode: 0o755 });
    for (const file of ["config.toml", "hooks.json"]) {
      await fs.writeFile(path.join(nativeHome, file), "", { mode: 0o644 });
    }
    params.appServer.start.homeScope = "user";
    params.appServer.start.env = { CODEX_HOME: nativeHome };
    const effectiveUid = 48001;
    vi.stubGlobal(
      "process",
      Object.assign(Object.create(process), {
        geteuid: owner === "no-uid" ? undefined : () => effectiveUid,
        getuid: owner === "no-uid" ? undefined : () => 48002,
      }),
    );
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      stat.uid = owner === "root" ? 0 : effectiveUid;
      return stat;
    });
    const context = await prepareCodexSandboxNativeContext(params);
    expect(context?.appServer.start.env?.CODEX_HOME).toBe(nativeHome);
    expect(context?.cwd).toBe(params.effectiveWorkspace);
  });

  it.each(["directories", "files"] as const)(
    "admits protected Windows %s with synthesized writable modes",
    async (target) => {
      const { params, factory } = prepare();
      const nativeHome = path.join(params.agentDir, "codex-home");
      await fs.mkdir(nativeHome, { mode: 0o700 });
      for (const file of ["config.toml", "hooks.json"]) {
        await fs.writeFile(path.join(nativeHome, file), "", { mode: 0o600 });
      }
      useWindowsMetadata(target);
      await expect(startCodexAttemptThread(params)).rejects.toThrow("captured startup options");
      expect(factory.mock.calls[0]?.[0]?.startOptions?.cwd).toBe(params.effectiveWorkspace);
    },
  );

  it("leaves native-enabled and unsandboxed startup options unchanged", async () => {
    const { params } = prepare();
    expect(
      await prepareCodexSandboxNativeContext({ ...params, nativeToolSurfaceEnabled: true }),
    ).toBeUndefined();
    expect(await prepareCodexSandboxNativeContext({ ...params, sandbox: null })).toBeUndefined();
    expect(params.appServer.start.cwd).toBeUndefined();
  });

  it("retains protected process options when startup retries after executable selection changes", async () => {
    const { params, factory } = prepare();
    factory.mockRejectedValueOnce(
      Object.assign(new Error("native selection changed"), {
        code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
      }),
    );
    await expect(startCodexAttemptThread(params)).rejects.toThrow("captured startup options");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls.map(([options]) => options?.startOptions)).toEqual([
      expect.objectContaining({
        cwd: path.join(root, "workspace"),
        args: expect.arrayContaining([
          "project_root_markers=[]",
          `projects={${JSON.stringify(params.effectiveWorkspace)}={trust_level="untrusted"}}`,
        ]),
      }),
      expect.objectContaining({
        cwd: path.join(root, "workspace"),
        args: expect.arrayContaining([
          "project_root_markers=[]",
          `projects={${JSON.stringify(params.effectiveWorkspace)}={trust_level="untrusted"}}`,
        ]),
      }),
    ]);
  });

  it.each([
    { name: "dotted", suffix: "with.dots", encodedSuffix: "with.dots" },
    { name: "control characters", suffix: "with.\n\t\u007f", encodedSuffix: "with.\\n\\t\\u007f" },
  ])(
    "canonicalizes a symlinked workspace with $name in its native trust key",
    async ({ suffix, encodedSuffix }) => {
      const { params } = prepare();
      const cwd = path.join(root, `workspace.${suffix}`);
      const alias = path.join(root, "workspace-alias");
      await fs.mkdir(cwd);
      await fs.symlink(cwd, alias);
      params.effectiveWorkspace = alias;
      params.sandbox!.workspaceDir = alias;
      params.sandbox!.agentWorkspaceDir = alias;

      const context = await prepareCodexSandboxNativeContext(params);

      expect(context?.cwd).toBe(cwd);
      expect(context?.appServer.start.cwd).toBe(cwd);
      expect(context?.appServer.start.args).toContain(
        `projects={"${root}/workspace.${encodedSuffix}"={trust_level="untrusted"}}`,
      );
      expect(context?.sandboxPolicy).toMatchObject({ writableRoots: [cwd] });
    },
  );

  it.each([
    {
      name: "missing trust",
      trust: undefined,
      disabledReason: "untrusted",
      error: "effective untrusted workspace",
    },
    {
      name: "managed trust override",
      trust: "trusted",
      disabledReason: "untrusted",
      error: "effective untrusted workspace",
    },
    {
      name: "enabled project layer",
      trust: "untrusted",
      disabledReason: undefined,
      error: "every project config layer to be disabled",
    },
    {
      name: "empty disabled reason",
      trust: "untrusted",
      disabledReason: "",
      error: "every project config layer to be disabled",
    },
  ])("rejects ineffective project isolation ($name)", async ({ trust, disabledReason, error }) => {
    const cwd = path.join(root, "workspace");
    const request = vi.fn(async () => ({
      config: { project_root_markers: [], projects: { [cwd]: { trust_level: trust } } },
      layers: [{ name: { type: "project" }, disabledReason }],
    }));
    await expect(
      readCodexInheritedMcpServerNames(
        { request } as unknown as Parameters<typeof readCodexInheritedMcpServerNames>[0],
        cwd,
        undefined,
        { requireProtectedNativeContext: true },
      ),
    ).rejects.toThrow(error);
  });

  it("admits native disabled project layers without importing their configuration", async () => {
    const cwd = path.join(root, "workspace");
    const request = vi.fn(async () => ({
      config: { project_root_markers: [], projects: { [cwd]: { trust_level: "untrusted" } } },
      layers: [
        {
          name: { type: "project" },
          disabledReason: "untrusted",
          config: { mcp_servers: { ignored: {} } },
        },
      ],
    }));
    await expect(
      readCodexInheritedMcpServerNames(
        { request } as unknown as Parameters<typeof readCodexInheritedMcpServerNames>[0],
        cwd,
        undefined,
        { requireProtectedNativeContext: true },
      ),
    ).resolves.toEqual([]);
  });

  it.each([undefined, [".git"]])(
    "rejects an effective native project root override %j",
    async (markers) => {
      const request = vi.fn(async () => ({
        config: { project_root_markers: markers },
        layers: [],
      }));
      await expect(
        readCodexInheritedMcpServerNames(
          { request } as unknown as Parameters<typeof readCodexInheritedMcpServerNames>[0],
          path.join(root, "agent"),
          undefined,
          { requireProtectedNativeContext: true },
        ),
      ).rejects.toThrow("effective project_root_markers=[]");
    },
  );
});
