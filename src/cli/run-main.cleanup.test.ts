import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../agents/harness/types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";

const dispatch = vi.hoisted(() => ({
  run: async () => {},
  command: undefined as Promise<void> | undefined,
  memoryClosed: vi.fn(async () => {}),
}));
// Only bootstrap/dispatch are replaced; process entry, registry scopes and cleanup are real.
vi.mock("./route.js", () => ({
  tryRouteCli: async () => {
    await dispatch.run();
    return true;
  },
}));
vi.mock("../infra/is-main.js", () => ({ isMainModule: () => true }));
vi.mock("../entry.esm-resolve-fast-path.js", () => ({ installDistEsmResolveFastPath() {} }));
vi.mock("../entry.version-fast-path.js", () => ({ tryHandleRootVersionFastPath: () => false }));
vi.mock("../entry.compile-cache.js", () => ({
  resolveEntryInstallRoot: () => process.cwd(),
  enableOpenClawCompileCache() {},
  respawnWithoutOpenClawCompileCacheIfNeeded: async () => false,
}));
vi.mock("../entry.respawn.js", () => ({ buildCliRespawnPlan: () => null }));
vi.mock("../infra/openclaw-exec-env.js", () => ({ ensureOpenClawExecMarkerOnProcess() {} }));
vi.mock("../infra/warning-filter.js", () => ({ installProcessWarningFilter() {} }));
vi.mock("../infra/unhandled-rejections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/unhandled-rejections.js")>()),
  installUnhandledRejectionHandler() {},
}));
vi.mock("../logging/console.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/console.js")>()),
  enableConsoleCapture() {},
  routeLogsToStderr() {},
}));
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath() {} }));
vi.mock("./dotenv.js", () => ({ loadCliDotEnv() {} }));
vi.mock("../config/io.js", () => ({ readBestEffortConfig: async () => ({}) }));
vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: async () => null,
  stopProxy: async () => {},
}));
vi.mock("../plugins/memory-state.js", () => ({ hasMemoryRuntime: () => true }));
vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagersCore: dispatch.memoryClosed,
}));
vi.mock("./gateway-cli/pre-bootstrap.js", () => ({ selectGatewayRunEnvironment: async () => {} }));
vi.mock("./gateway-cli/run-command.js", () => ({
  addGatewayRunCommand: (command: import("commander").Command) =>
    command.action(() => dispatch.run()),
}));
vi.mock("./command-execution-startup.js", () => ({ ensureCliExecutionBootstrap: async () => {} }));
vi.mock("./banner.js", () => ({ emitCliBanner() {} }));
vi.mock("./one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput() {},
  runCliWithExitFinalization: ({ run }: { run: () => Promise<void> }) => {
    dispatch.command = run();
    void dispatch.command.catch(() => {});
    return dispatch.command;
  },
}));

function resourceHarness(id: string, gate?: Deferred) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<unknown[]> | undefined;
  let output: readline.Interface | undefined;
  let disposeCalls = 0;
  const entered = createDeferredCore();
  const pending = new Map<string, Deferred>();
  function line(value: string) {
    const next = createDeferredCore();
    pending.set(value, next);
    return next.promise;
  }
  const harness: AgentHarness = {
    id,
    label: id,
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("catalog-only fixture");
    },
    loadModelCatalog: async () => {
      const ready = line("ready");
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import readline from "node:readline";
        const lines = readline.createInterface({ input: process.stdin });
        lines.on("line", () => process.stdout.write("pong\\n"));
        lines.on("close", () => process.stdout.end("stdin-end\\n"));
        process.stdout.write("ready\\n");
      `,
        ],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
      );
      closed = once(child, "close");
      output = readline.createInterface({ input: child.stdout });
      output.on("line", (value) => pending.get(value)?.resolve());
      await ready;
      return [];
    },
    dispose: async () => {
      disposeCalls++;
      entered.resolve();
      await gate?.promise;
      child?.stdin.end();
      await closed;
    },
  };
  return {
    harness,
    entered,
    async ping() {
      const pong = line("pong");
      child?.stdin.write("ping\n");
      await pong;
    },
    snapshot: () => ({ disposeCalls, exitCode: child?.exitCode, signalCode: child?.signalCode }),
    async closeAndJoin() {
      gate?.resolve();
      // Setup can fail before spawn; teardown must preserve that original error.
      if (!child) {
        return;
      }
      child.stdin.end();
      await closed;
      output?.close();
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBe(null);
    },
  };
}

const argv = [
  "node",
  "openclaw",
  "onboard",
  "--non-interactive",
  "--accept-risk",
  "--flow",
  "import",
];
let registryApi: typeof import("../agents/harness/registry.js");
let runtime: typeof import("../plugins/runtime.js");
let scopes: typeof import("../plugins/runtime/gateway-request-scope.js");
let emptyRegistry: typeof import("../plugins/registry-empty.js");
let originalRegistrySnapshot: ReturnType<typeof runtime.captureActivePluginRegistrySnapshot>;
let originalArgv: string[];
let originalTitle: string;
let originalListeners: ReturnType<typeof process.listeners>;

beforeEach(async () => {
  vi.resetModules();
  registryApi = await import("../agents/harness/registry.js");
  runtime = await import("../plugins/runtime.js");
  scopes = await import("../plugins/runtime/gateway-request-scope.js");
  emptyRegistry = await import("../plugins/registry-empty.js");
  originalRegistrySnapshot = runtime.captureActivePluginRegistrySnapshot();
  originalArgv = process.argv;
  originalTitle = process.title;
  originalListeners = process.listeners("uncaughtException");
  process.argv = argv;
  runtime.setActivePluginRegistry(emptyRegistry.createEmptyPluginRegistry());
  dispatch.command = undefined;
  dispatch.memoryClosed.mockClear();
});
afterEach(() => {
  process.argv = originalArgv;
  process.title = originalTitle;
  runtime.restoreActivePluginRegistrySnapshot(originalRegistrySnapshot);
  for (const listener of process.listeners("uncaughtException")) {
    if (!originalListeners.includes(listener)) {
      process.off("uncaughtException", listener);
    }
  }
});

function registerHarness(registry: PluginRegistry, harness: AgentHarness) {
  runtime.withPluginRegistrationContext(registry, "fixture", () =>
    registryApi.registerAgentHarness(harness),
  );
}

async function acquire(id: string) {
  await registryApi.getRegisteredAgentHarness(id)!.harness.loadModelCatalog!({
    config: {},
    agentId: "test",
    agentDir: process.cwd(),
    workspaceDir: process.cwd(),
  });
}
async function runProcessEntry() {
  await import("../index.js");
  await dispatch.command;
}

describe("CLI process harness cleanup", () => {
  it.each(["current", "transient-resolve", "transient-reject"])(
    "joins %s resources at process completion",
    async (mode) => {
      const registry =
        mode === "current"
          ? runtime.getActivePluginRegistry()!
          : emptyRegistry.createEmptyPluginRegistry();
      const resource = resourceHarness(mode);
      registerHarness(registry, resource.harness);
      const actionError = new Error("synthetic action failure");
      dispatch.run = async () => {
        await scopes.withPluginRuntimeRegistryScope(registry, () => acquire(mode));
        if (mode === "transient-reject") {
          throw actionError;
        }
      };
      try {
        const error = await runProcessEntry().catch((cause: unknown) => cause);
        const atReturn = resource.snapshot();
        if (atReturn.exitCode === null) {
          await resource.ping();
        }
        expect(error).toBe(mode === "transient-reject" ? actionError : undefined);
        expect(atReturn).toEqual({ disposeCalls: 1, exitCode: 0, signalCode: null });
      } finally {
        await resource.closeAndJoin();
      }
    },
  );

  it("awaits a transient disposer before later finalizers and process completion", async () => {
    const registry = emptyRegistry.createEmptyPluginRegistry();
    const gate = createDeferredCore();
    const resource = resourceHarness("awaited", gate);
    registerHarness(registry, resource.harness);
    dispatch.run = () => scopes.withPluginRuntimeRegistryScope(registry, () => acquire("awaited"));
    let returned = false;
    const command = runProcessEntry().then(() => {
      returned = true;
    });
    try {
      // Early command return must fail the assertion and still reach fixture teardown.
      await Promise.race([resource.entered.promise, command]);
      expect(returned).toBe(false);
      await resource.ping();
      expect(dispatch.memoryClosed).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      try {
        await command;
      } finally {
        await resource.closeAndJoin();
      }
    }
    expect(dispatch.memoryClosed).toHaveBeenCalledOnce();
  });

  it("retains transient cleanup from the primary executable bootstrap", async () => {
    const registry = emptyRegistry.createEmptyPluginRegistry();
    const resource = resourceHarness("primary-entry");
    registerHarness(registry, resource.harness);
    dispatch.run = () =>
      scopes.withPluginRuntimeRegistryScope(registry, () => acquire("primary-entry"));
    try {
      await import("../entry.js");
      await dispatch.command;
      expect(resource.snapshot()).toEqual({ disposeCalls: 1, exitCode: 0, signalCode: null });
    } finally {
      await resource.closeAndJoin();
    }
  });

  it.each(["helper", "direct", "legacy", "gateway", "gateway-run", "gateway-legacy"])(
    "leaves %s transient resources with their owner",
    async (mode) => {
      const registry = emptyRegistry.createEmptyPluginRegistry();
      const resource = resourceHarness("borrowed");
      registerHarness(registry, resource.harness);
      dispatch.run = () =>
        scopes.withPluginRuntimeRegistryScope(registry, () => acquire("borrowed"));
      try {
        if (mode === "helper") {
          const { withAgentPluginRegistry } = await import("../agents/runtime-plugins.js");
          await scopes.withPluginRuntimeRegistryScope(registry, () =>
            withAgentPluginRegistry({
              config: {},
              workspaceDir: process.cwd(),
              run: () => acquire("borrowed"),
            }),
          );
        } else if (mode === "direct") {
          const { runCli } = await import("./run-main.js");
          await runCli(argv);
        } else if (mode === "legacy") {
          const action = dispatch.run;
          dispatch.run = async () => {};
          const { runLegacyCliEntry } = await import("../index.js");
          await dispatch.command;
          dispatch.run = action;
          await runLegacyCliEntry(argv, undefined, { retainConsoleRoutingUntilProcessExit: true });
        } else {
          if (mode === "gateway-legacy") {
            const borrowedAction = dispatch.run;
            dispatch.run = async () => {
              dispatch.run = borrowedAction;
              const { runLegacyCliEntry } = await import("../index.js");
              await runLegacyCliEntry(argv, undefined, {
                retainConsoleRoutingUntilProcessExit: true,
              });
            };
          }
          process.argv = [
            "node",
            "openclaw",
            "gateway",
            ...(mode === "gateway-run" ? ["run"] : []),
          ];
          await runProcessEntry();
        }
        expect(resource.snapshot()).toEqual({ disposeCalls: 0, exitCode: null, signalCode: null });
        await resource.ping();
        const { isPluginRegistryRetired } = await import("../plugins/registry-lifecycle.js");
        expect(isPluginRegistryRetired(registry)).toBe(false);
      } finally {
        await scopes.withPluginRuntimeRegistryScope(
          registry,
          registryApi.disposeRegisteredAgentHarnesses,
        );
        await resource.closeAndJoin();
      }
      expect(resource.snapshot().disposeCalls).toBe(1);
    },
  );

  it("deduplicates exact instances, preserves their first disposal context and continues after errors", async () => {
    const registry = emptyRegistry.createEmptyPluginRegistry();
    const second = emptyRegistry.createEmptyPluginRegistry();
    const resources = [resourceHarness("shared"), resourceHarness("shared")];
    const order: string[] = [];
    const contexts: unknown[] = [];
    for (const [index, target] of [registry, second].entries()) {
      const resource = resources[index]!;
      const dispose = resource.harness.dispose!.bind(resource.harness);
      resource.harness.dispose = async function () {
        contexts.push([
          this,
          runtime.getPluginRegistryForContext(),
          scopes.getPluginRuntimeGatewayRequestScope()?.pluginId,
        ]);
        order.push(`dispose-${index}`);
        await dispose();
        contexts.push(runtime.getPluginRegistryForContext());
        if (index === 0) {
          throw new Error("synthetic disposer failure");
        }
      };
      registerHarness(target, resource.harness);
    }
    // The same exact registration can also be visible from the current registry.
    runtime.getActivePluginRegistry()!.agentHarnesses.push(registry.agentHarnesses[0]!);
    dispatch.run = async () => {
      for (const [index, target] of [registry, second].entries()) {
        await scopes.withPluginRuntimeRegistryScope(target, () =>
          scopes.withPluginRuntimePluginIdScope(`request-${index}`, async () => {
            await acquire("shared");
            registryApi.getRegisteredAgentHarness("shared");
            registryApi.listRegisteredAgentHarnesses();
          }),
        );
      }
    };
    try {
      await runProcessEntry();
      expect(order).toEqual(["dispose-0", "dispose-1"]);
      expect(contexts.slice(0, 2)).toEqual([
        [registry.agentHarnesses[0]!.harness, registry, "request-0"],
        [second.agentHarnesses[0]!.harness, second, "request-1"],
      ]);
      expect(contexts.slice(2)).toEqual(expect.arrayContaining([registry, second]));
      expect(resources.map((resource) => resource.snapshot().disposeCalls)).toEqual([1, 1]);
      expect(dispatch.memoryClosed).toHaveBeenCalledOnce();
    } finally {
      await Promise.all(resources.map((resource) => resource.closeAndJoin()));
    }
  });

  it("rejects reuse of cleaned registrations without retiring unused cache entries", async () => {
    const { pluginLoaderCacheState } = await import("../plugins/registry-lifecycle.js");
    const unused = emptyRegistry.createEmptyPluginRegistry();
    pluginLoaderCacheState.set("cleanup-unused", unused);
    const { withCliProcessScope } = await import("./runtime-cleanup-scope.js");
    const { runCli } = await import("./run-main.js");
    for (let invocation = 0; invocation < 2; invocation++) {
      const registry = emptyRegistry.createEmptyPluginRegistry();
      const resource = resourceHarness("sequential");
      registerHarness(registry, resource.harness);
      pluginLoaderCacheState.set("cleanup-used", registry);
      let retainedLookup:
        | (() => ReturnType<typeof registryApi.getRegisteredAgentHarness>)
        | undefined;
      dispatch.run = () =>
        scopes.withPluginRuntimeRegistryScope(registry, async () => {
          await acquire("sequential");
          retainedLookup = AsyncLocalStorage.bind(() =>
            registryApi.getRegisteredAgentHarness("sequential"),
          );
        });
      try {
        await withCliProcessScope(() => runCli(argv));
        expect(pluginLoaderCacheState.get("cleanup-used")).toBeUndefined();
        expect(pluginLoaderCacheState.get("cleanup-unused")).toBe(unused);
        expect(resource.snapshot()).toEqual({ disposeCalls: 1, exitCode: 0, signalCode: null });
        expect(retainedLookup).toBeDefined();
        expect(retainedLookup!()).toBeUndefined();
      } finally {
        await resource.closeAndJoin();
      }
    }
  });
});
