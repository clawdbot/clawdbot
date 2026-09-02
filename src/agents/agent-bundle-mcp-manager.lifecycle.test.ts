import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import {
  SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime, SessionMcpRuntimeManager } from "./agent-bundle-mcp-types.js";
import { testing as resolverTesting } from "./mcp-connection-resolver.js";

vi.mock("./agent-bundle-mcp-runtime.js", () => {
  throw new Error("Lifecycle-only MCP work must not import the transport runtime");
});

const managers: SessionMcpRuntimeManager[] = [];
const releaseHeldWork: Array<() => void> = [];
const params = {
  sessionId: "lifecycle-session",
  sessionKey: "agent:test:lifecycle-session",
  workspaceDir: "/workspace",
  agentDir: "/agents/test",
  cfg: { mcp: { servers: {} } },
  manifestRegistry: { plugins: [] },
};

function createRuntimeFixture(input: Parameters<CreateSessionMcpRuntime>[0]): SessionMcpRuntime {
  let lastUsedAt = Date.now();
  let activeLeases = 0;
  return {
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    workspaceDir: input.workspaceDir,
    agentDir: input.agentDir,
    requesterScope: input.requesterScope,
    configFingerprint: input.configFingerprint ?? "fixture",
    createdAt: lastUsedAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease() {
      activeLeases += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          activeLeases -= 1;
        }
      };
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: async () => ({ content: [] }),
    dispose: vi.fn(async () => {}),
  };
}

function createManager(createRuntime?: CreateSessionMcpRuntime) {
  const manager = createSessionMcpRuntimeManager({ createRuntime, enableIdleSweepTimer: false });
  managers.push(manager);
  return manager;
}

function holdFactory() {
  const started = createDeferred<SessionMcpRuntime>();
  const released = createDeferred();
  releaseHeldWork.push(() => released.resolve());
  const createRuntime: CreateSessionMcpRuntime = async (input) => {
    const runtime = createRuntimeFixture(input);
    started.resolve(runtime);
    await released.promise;
    return runtime;
  };
  return { createRuntime, started: started.promise, release: () => released.resolve() };
}

function holdDisposal(runtime: SessionMcpRuntime) {
  const started = createDeferred();
  const released = createDeferred();
  releaseHeldWork.push(() => released.resolve());
  runtime.dispose = vi.fn(async () => {
    started.resolve();
    await released.promise;
  });
  return { started: started.promise, release: () => released.resolve() };
}

afterEach(async () => {
  for (const release of releaseHeldWork.splice(0)) {
    release();
  }
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  resolverTesting.setMcpServerConnectionResolversForTest();
});

describe("MCP manager creation ownership", () => {
  it("constructs and retires an empty manager without binding or importing transports", async () => {
    const manager = createManager();

    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    expect(manager.deferRetirement(params.sessionId)).toBe(false);
    await expect(manager.completeDeferredRetirement(params.sessionId)).resolves.toBe(false);
    await manager.disposeSession(params.sessionId);
    await manager.disposeAll();

    expect(manager.listRuntimeKeys()).toEqual([]);
  });

  it.each(["static", "requester"] as const)(
    "keeps the native idle timer outside %s requesting turns across disposal",
    async (entrypoint) => {
      const turnContext = new AsyncLocalStorage<string>();
      const pendingInputContext = new AsyncLocalStorage<string>();
      const readContext = () => ({
        turn: turnContext.getStore(),
        pendingInput: pendingInputContext.getStore(),
      });
      const timerContexts: ReturnType<typeof readContext>[] = [];
      const factoryContexts: ReturnType<typeof readContext>[] = [];
      const nativeSetInterval = globalThis.setInterval;
      const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
        if (args[1] === SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS) {
          timerContexts.push(readContext());
        }
        return nativeSetInterval(...args);
      });
      const manager = createSessionMcpRuntimeManager({
        createRuntime(input) {
          factoryContexts.push(readContext());
          return createRuntimeFixture(input);
        },
      });
      managers.push(manager);
      resolverTesting.setMcpServerConnectionResolversForTest([
        { serverName: "scoped", resolve: async () => ({ url: "https://mcp.example.test/scoped" }) },
      ]);

      try {
        for (const turn of ["first turn", "later turn"]) {
          const pendingInput = `${turn} input`;
          await turnContext.run(turn, () =>
            pendingInputContext.run(pendingInput, async () => {
              if (entrypoint === "static") {
                await manager.getOrCreate(params);
              } else {
                await manager.getOrCreateRequesterScoped({
                  ...params,
                  requesterSenderId: "sender",
                  cfg: { mcp: { servers: { scoped: { transport: "streamable-http" } } } },
                });
              }
              expect(readContext()).toEqual({ turn, pendingInput });
            }),
          );
          expect(factoryContexts.splice(0)).toEqual([{ turn, pendingInput }]);
          expect(timerContexts.splice(0)).toEqual([{ turn: undefined, pendingInput: undefined }]);
          await manager.disposeAll();
        }
      } finally {
        await manager.disposeAll();
        intervalSpy.mockRestore();
      }
    },
  );

  it.each(["session", "all"] as const)(
    "drains late creation during %s disposal without publishing or clearing a successor",
    async (scope) => {
      const first = holdFactory();
      const next = holdFactory();
      const createRuntime = vi
        .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
        .mockImplementationOnce(first.createRuntime)
        .mockImplementationOnce(next.createRuntime);
      const manager = createManager(createRuntime);
      const oldRequest = manager.getOrCreate(params);
      const oldOutcome = oldRequest.catch((error: unknown) => error);
      const oldRuntime = await first.started;
      const closing = holdDisposal(oldRuntime);
      let drained = false;
      const disposal = (
        scope === "session" ? manager.disposeSession(params.sessionId) : manager.disposeAll()
      ).then(() => {
        drained = true;
      });

      const nextRequest = manager.getOrCreate(params);
      const nextRuntime = await next.started;
      first.release();
      await closing.started;
      expect(drained).toBe(false);
      expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
      closing.release();
      await disposal;
      expect(await oldOutcome).toMatchObject({ message: expect.stringContaining("superseded") });
      expect(oldRuntime.dispose).toHaveBeenCalledOnce();

      // The old producer's finally and teardown both ran while this claim was pending.
      const concurrentRequest = manager.getOrCreate(params);
      next.release();
      const [created, concurrent] = await Promise.all([nextRequest, concurrentRequest]);
      expect(created).toBe(nextRuntime);
      expect(concurrent).toBe(nextRuntime);
      expect(createRuntime).toHaveBeenCalledTimes(2);
      expect(manager.peekSession({ sessionKey: params.sessionKey })).toBe(nextRuntime);
      expect(nextRuntime.dispose).not.toHaveBeenCalled();
      await expect(manager.getOrCreate(params)).resolves.toBe(nextRuntime);

      await manager.disposeAll();
      expect(nextRuntime.dispose).toHaveBeenCalledOnce();
      const subsequent = await manager.getOrCreate(params);
      expect(subsequent).not.toBe(nextRuntime);
      expect(manager.peekSession({ sessionId: params.sessionId })).toBe(subsequent);
    },
  );

  it.each([
    { label: "workspace", update: { workspaceDir: "/other-workspace" } },
    { label: "agent", update: { agentDir: "/agents/other" } },
    { label: "config", update: { cfg: { mcp: { apps: { enabled: true }, servers: {} } } } },
  ])("claims a $label replacement before awaiting old runtime disposal", async ({ update }) => {
    const next = holdFactory();
    const createRuntime = vi
      .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
      .mockImplementationOnce(createRuntimeFixture)
      .mockImplementationOnce(next.createRuntime);
    const manager = createManager(createRuntime);
    const oldRuntime = await manager.getOrCreate(params);
    const closing = holdDisposal(oldRuntime);
    const changed = { ...params, ...update };
    const replacement = manager.getOrCreate(changed);
    await closing.started;
    const concurrent = manager.getOrCreate(changed);
    // Join the public idle-sweep boundary while old disposal remains blocked.
    await manager.sweepIdleRuntimes();
    expect(createRuntime).toHaveBeenCalledOnce();

    closing.release();
    const nextRuntime = await next.started;
    next.release();
    await expect(replacement).resolves.toBe(nextRuntime);
    await expect(concurrent).resolves.toBe(nextRuntime);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
  });

  it("supersedes a pending factory without duplicating its replacement", async () => {
    const first = holdFactory();
    const next = holdFactory();
    const createRuntime = vi
      .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
      .mockImplementationOnce(first.createRuntime)
      .mockImplementationOnce(next.createRuntime);
    const manager = createManager(createRuntime);
    const oldRequest = manager.getOrCreate(params).catch((error: unknown) => error);
    const oldRuntime = await first.started;
    const changed = { ...params, workspaceDir: "/replacement-workspace" };
    const replacement = manager.getOrCreate(changed);
    const concurrent = manager.getOrCreate(changed);
    await manager.sweepIdleRuntimes();
    first.release();

    const nextRuntime = await next.started;
    expect(await oldRequest).toMatchObject({ message: expect.stringContaining("superseded") });
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    next.release();
    await expect(replacement).resolves.toBe(nextRuntime);
    await expect(concurrent).resolves.toBe(nextRuntime);
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it("keeps required retirement armed across delayed creation and reuse", async () => {
    const held = holdFactory();
    const manager = createManager(held.createRuntime);
    manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
    const creating = manager.getOrCreate(params);
    const runtime = await held.started;
    held.release();
    await creating;
    const release = expectDefined(runtime.acquireLease, "fixture runtime lease")();

    expect(runtime.mcpAppModelContextRevoked).toBe(true);
    await expect(manager.getOrCreate(params)).resolves.toBe(runtime);
    await expect(manager.completeDeferredRetirement(params.sessionId, runtime)).resolves.toBe(
      false,
    );
    release();
    await expect(manager.completeDeferredRetirement(params.sessionId, runtime)).resolves.toBe(true);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(manager.listRuntimeKeys()).toEqual([]);
  });

  it("serializes requester replacement behind global disposal instead of clearing its lock", async () => {
    resolverTesting.setMcpServerConnectionResolversForTest([
      { serverName: "scoped", resolve: async () => ({ url: "https://mcp.example.test/scoped" }) },
    ]);
    const first = holdFactory();
    const next = holdFactory();
    const createRuntime = vi
      .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
      .mockImplementationOnce(first.createRuntime)
      .mockImplementationOnce(next.createRuntime);
    const manager = createManager(createRuntime);
    const scoped = {
      ...params,
      requesterSenderId: "sender",
      cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
    };
    const firstRequest = manager.getOrCreateRequesterScoped(scoped);
    const oldRuntime = await first.started;
    const closing = holdDisposal(oldRuntime);
    const disposal = manager.disposeAll();
    const nextRequest = manager.getOrCreateRequesterScoped(scoped);
    first.release();
    await closing.started;
    expect(createRuntime).toHaveBeenCalledOnce();
    closing.release();
    await disposal;
    await firstRequest;

    const nextRuntime = await next.started;
    next.release();
    expect((await nextRequest)?.runtime).toBe(nextRuntime);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
    expect(nextRuntime.dispose).not.toHaveBeenCalled();
    expect(manager.listSessionIds()).toEqual([params.sessionId]);
    expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
  });
});
