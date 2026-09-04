import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
const getCurrentPluginConversationBinding = vi.hoisted(() => vi.fn(async () => null));
const cleanupReplacedPluginHostRegistry = vi.hoisted(() =>
  vi.fn(async () => ({ cleanupCount: 0, failures: [] })),
);

vi.mock("./host-hook-cleanup.js", () => ({ cleanupReplacedPluginHostRegistry }));
vi.mock("./conversation-binding.js", () => ({
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding: vi.fn(),
  detachPluginConversationBinding: vi.fn(),
}));

import { getPluginCommandExecutionCount } from "./command-execution-lock.js";
import { registerPluginCommandInRegistry } from "./command-registration.js";
import { createPluginRecord } from "./loader-records.js";
import {
  createPluginCommandRuntime,
  executePluginCommandDispatch,
  matchPluginCommandInvocation,
  type PluginCommandDispatch,
} from "./plugin-command-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import {
  clearActivePluginRegistry,
  prepareActivePluginRegistryShutdown,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

const executionContext = {
  senderId: "user-1",
  channel: "telegram",
  isAuthorizedSender: true,
  commandBody: "/demo",
  config: {},
} as const;

function registerCommand(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
  params: {
    pluginId: string;
    name: string;
    channels?: string[];
    nativeNames?: Record<string, string>;
    acceptsArgs?: boolean;
    handler: (args?: string) => Promise<{ text: string }>;
  },
) {
  const result = registerPluginCommandInRegistry(registry, params.pluginId, {
    name: params.name,
    description: `${params.pluginId} command`,
    channels: params.channels,
    nativeNames: params.nativeNames,
    acceptsArgs: params.acceptsArgs,
    handler: async (ctx) => await params.handler(ctx.args),
  });
  expect(result).toEqual({ ok: true });
}

function requirePluginDispatch(
  candidate: ReturnType<
    ReturnType<typeof createPluginCommandRuntime>["listNativeCandidates"]
  >[number],
  args?: string,
) {
  const dispatch = candidate.prepareDispatch(args);
  expect(dispatch.kind).toBe("plugin");
  if (dispatch.kind !== "plugin") {
    throw new Error("expected plugin command dispatch");
  }
  return dispatch;
}

afterEach(() => {
  cleanupReplacedPluginHostRegistry.mockClear();
  getCurrentPluginConversationBinding.mockClear();
  resetPluginRuntimeStateForTest();
});

describe("plugin command runtime", () => {
  it("keeps failed command diagnostics scoped, authorized, redacted, and bounded", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      ...createPluginRecord({
        id: "recovery",
        source: "/plugins/recovery/index.js",
        origin: "config",
        enabled: true,
        configSchema: true,
      }),
      status: "error",
      failurePhase: "validation",
      error: `missing payload token=fixture-secret-value private-detail ${"x".repeat(400)}\n    at loader`,
      commandAliases: [{ name: "recover", kind: "runtime-slash" }],
    });
    setActivePluginRegistry(registry);
    withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
      expect(
        matchPluginCommandInvocation(createPluginCommandRuntime(), "/recover stop", {
          channel: "telegram",
        }),
      ).toBeNull();
    });
    const disabled = createEmptyPluginRegistry();
    disabled.plugins.push({ ...registry.plugins[0]!, enabled: false });
    withPluginRuntimeRegistryScope(disabled, () => {
      expect(
        matchPluginCommandInvocation(createPluginCommandRuntime(), "/recover stop", {
          channel: "telegram",
        }),
      ).toBeNull();
    });
    const match = matchPluginCommandInvocation(createPluginCommandRuntime(), "/recover stop", {
      channel: "telegram",
    });
    expect(match).not.toBeNull();
    if (!match) {
      throw new Error("expected failed command diagnostic");
    }
    await expect(
      match.dispatch.execute({ ...executionContext, isAuthorizedSender: false }),
    ).resolves.toEqual({ text: "⚠️ This command requires authorization." });
    const reply = await match.dispatch.execute({
      ...executionContext,
      config: { logging: { redactPatterns: ["private-detail"] } },
    });
    expect(reply.text).toContain("missing payload");
    expect(reply.text).toContain("openclaw doctor");
    expect(reply.text).not.toMatch(/fixture-secret-value|private-detail|at loader/);
    expect(reply.text!.length).toBeLessThan(400);
  });

  it("prepares plugin host cleanup before gateway shutdown", async () => {
    await prepareActivePluginRegistryShutdown();
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ status: "loaded" } as never);
    setActivePluginRegistry(registry);

    await clearActivePluginRegistry();

    expect(cleanupReplacedPluginHostRegistry).toHaveBeenCalledOnce();
  });

  it("binds the request-scoped registry and scopes provider aliases", async () => {
    const ambient = createEmptyPluginRegistry();
    const scoped = createEmptyPluginRegistry();
    const ambientHandler = vi.fn(async () => ({ text: "ambient" }));
    const scopedHandler = vi.fn(async (args?: string) => ({ text: `scoped:${args}` }));
    registerCommand(ambient, {
      pluginId: "ambient",
      name: "demo",
      handler: ambientHandler,
    });
    registerCommand(scoped, {
      pluginId: "scoped",
      name: "demo",
      channels: ["discord"],
      nativeNames: { discord: "discord-demo" },
      acceptsArgs: true,
      handler: scopedHandler,
    });
    setActivePluginRegistry(ambient);

    await withPluginRuntimeRegistryScope(scoped, async () => {
      const runtime = createPluginCommandRuntime();
      expect(runtime.listNativeCandidates("telegram")).toEqual([]);
      const candidates = runtime.listNativeCandidates("discord");
      expect(candidates.map((candidate) => candidate.name)).toEqual(["discord-demo"]);
      expect(
        matchPluginCommandInvocation(runtime, "/discord-demo hi", { channel: "telegram" }),
      ).toBeNull();
      const match = matchPluginCommandInvocation(runtime, "/discord-demo hi", {
        channel: "discord",
      });
      expect(match?.dispatch.kind).toBe("plugin");
      if (!match) {
        throw new Error("expected scoped command match");
      }
      const result = await match.dispatch.execute({
        ...executionContext,
        channel: "discord",
        commandBody: "/discord-demo hi",
      });
      expect(result).toEqual({ text: "scoped:hi" });
    });
    expect(scopedHandler).toHaveBeenCalledOnce();
    expect(ambientHandler).not.toHaveBeenCalled();
  });

  it.each(["provider", "fallback"])(
    "resolves %s conversation bindings through the command's selected registry",
    async (resolution) => {
      const createRegistry = (owner: string) =>
        createTestRegistry([
          {
            pluginId: "room-chat",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "room-chat",
                config: { defaultAccountId: () => `${owner}-account` },
              }),
              bindings: {
                resolveCommandConversation: () =>
                  resolution === "provider" ? { conversationId: `${owner}-room` } : null,
              },
              messaging: { normalizeTarget: () => `channel:${owner}-room` },
            },
          },
        ]);
      const ambient = createRegistry("ambient");
      const scoped = createRegistry("scoped");
      expect(
        registerPluginCommandInRegistry(
          scoped,
          "demo",
          {
            name: "demo",
            description: "Inspect this conversation",
            handler: async (ctx) => {
              await ctx.getCurrentConversationBinding();
              return { text: ctx.accountId };
            },
          },
          { pluginRoot: "/plugins/demo" },
        ),
      ).toEqual({ ok: true });
      setActivePluginRegistry(ambient);

      const dispatch = withPluginRuntimeRegistryScope(scoped, () =>
        requirePluginDispatch(createPluginCommandRuntime().listNativeCandidates("room-chat")[0]!),
      );
      await expect(
        dispatch.execute({ ...executionContext, channel: "room-chat", to: "room-chat:opaque" }),
      ).resolves.toEqual({ text: "scoped-account" });
      expect(getCurrentPluginConversationBinding).toHaveBeenCalledWith({
        pluginRoot: "/plugins/demo",
        conversation: {
          channel: "room-chat",
          accountId: "scoped-account",
          conversationId: "scoped-room",
        },
      });
    },
  );

  it("rejects forged, cross-runtime, wrong-channel, and retired selections", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async () => ({ text: "ok" }));
    registerCommand(registry, { pluginId: "demo", name: "demo", handler });
    setActivePluginRegistry(registry);
    const firstRuntime = createPluginCommandRuntime();
    const secondRuntime = createPluginCommandRuntime();
    const dispatch = requirePluginDispatch(firstRuntime.listNativeCandidates("telegram")[0]!);
    const secondDispatch = requirePluginDispatch(
      secondRuntime.listNativeCandidates("telegram")[0]!,
    );
    const forged = Object.freeze({
      kind: "plugin",
      execute: dispatch.execute,
    }) as PluginCommandDispatch;

    await expect(executePluginCommandDispatch(forged, executionContext)).resolves.toMatchObject({
      text: expect.stringContaining("no longer valid"),
    });
    await expect(dispatch.execute.call(secondDispatch, executionContext)).resolves.toMatchObject({
      text: expect.stringContaining("no longer valid"),
    });
    await expect(
      dispatch.execute({
        ...executionContext,
        channel: "discord",
      }),
    ).resolves.toMatchObject({ text: expect.stringContaining("no longer valid") });

    markPluginRegistryRetired(registry);
    await expect(dispatch.execute(executionContext)).resolves.toMatchObject({
      text: expect.stringContaining("registry changed"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps overlapping executions locked until both handlers settle", async () => {
    const registry = createEmptyPluginRegistry();
    const releases: Array<() => void> = [];
    registerCommand(registry, {
      pluginId: "slow",
      name: "slow",
      handler: async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { text: "done" };
      },
    });
    setActivePluginRegistry(registry);
    const runtime = createPluginCommandRuntime();
    const candidate = runtime.listNativeCandidates("telegram")[0]!;
    const first = requirePluginDispatch(candidate);
    const second = requirePluginDispatch(candidate);
    const firstRun = first.execute(executionContext);
    const secondRun = second.execute(executionContext);
    await vi.waitFor(() => expect(getPluginCommandExecutionCount(registry)).toBe(2));

    expect(
      registerPluginCommandInRegistry(registry, "blocked", {
        name: "blocked",
        description: "blocked",
        handler: async () => ({ text: "blocked" }),
      }),
    ).toMatchObject({ ok: false });
    releases.shift()?.();
    await vi.waitFor(() => expect(getPluginCommandExecutionCount(registry)).toBe(1));
    expect(
      registerPluginCommandInRegistry(registry, "still-blocked", {
        name: "still-blocked",
        description: "still blocked",
        handler: async () => ({ text: "blocked" }),
      }),
    ).toMatchObject({ ok: false });
    releases.shift()?.();
    await Promise.all([firstRun, secondRun]);
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
    expect(
      registerPluginCommandInRegistry(registry, "ready", {
        name: "ready",
        description: "ready",
        handler: async () => ({ text: "ready" }),
      }),
    ).toEqual({ ok: true });
  });

  it("admits an invocation before retirement but rejects later starts", async () => {
    const registry = createEmptyPluginRegistry();
    let release!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      registerCommand(registry, {
        pluginId: "slow",
        name: "slow",
        handler: async () => {
          resolveEntered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { text: "finished" };
        },
      });
    });
    setActivePluginRegistry(registry);
    const runtime = createPluginCommandRuntime();
    const candidate = runtime.listNativeCandidates("telegram")[0]!;
    const admitted = requirePluginDispatch(candidate);
    const late = requirePluginDispatch(candidate);
    const running = admitted.execute(executionContext);
    await entered;
    markPluginRegistryRetired(registry);
    await expect(late.execute(executionContext)).resolves.toMatchObject({
      text: expect.stringContaining("registry changed"),
    });
    release();
    await expect(running).resolves.toEqual({ text: "finished" });
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
  });

  it("does not prepare arguments for commands that reject them", () => {
    const registry = createEmptyPluginRegistry();
    registerCommand(registry, {
      pluginId: "demo",
      name: "demo",
      handler: async () => ({ text: "ok" }),
    });
    setActivePluginRegistry(registry);
    const candidate = createPluginCommandRuntime().listNativeCandidates("telegram")[0]!;
    expect(candidate.prepareDispatch("unexpected")).toEqual({ kind: "non-plugin" });
  });

  it("preserves the shipped catalog-retention call and rejects retired runtimes", () => {
    const registry = createEmptyPluginRegistry();
    registerCommand(registry, {
      pluginId: "demo",
      name: "demo",
      channels: ["telegram"],
      handler: async () => ({ text: "ok" }),
    });
    setActivePluginRegistry(registry);
    const runtime = createPluginCommandRuntime();
    expect(() => runtime.retainNativeCatalog("telegram")).not.toThrow();
    expect(() => runtime.retainNativeCatalog("discord")).not.toThrow();
    markPluginRegistryRetired(registry);
    expect(() => runtime.retainNativeCatalog("telegram")).toThrow("retired registry generation");
  });

  it("defers full registry cleanup until an admitted command settles", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ status: "loaded" } as never);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerCommand(registry, {
      pluginId: "slow",
      name: "slow",
      handler: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { text: "done" };
      },
    });
    setActivePluginRegistry(registry);
    const dispatch = requirePluginDispatch(
      createPluginCommandRuntime().listNativeCandidates("telegram")[0]!,
    );
    const running = dispatch.execute(executionContext);
    await started;
    let clearSettled = false;
    const clearing = clearActivePluginRegistry().then(() => {
      clearSettled = true;
    });
    await Promise.resolve();
    expect(clearSettled).toBe(false);
    expect(cleanupReplacedPluginHostRegistry).not.toHaveBeenCalled();
    release();
    await expect(running).resolves.toEqual({ text: "done" });
    await clearing;
    expect(cleanupReplacedPluginHostRegistry).toHaveBeenCalledOnce();
  });

  it("lets repeated command-triggered clears return without deadlocking their drain", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ status: "loaded" } as never);
    registerCommand(registry, {
      pluginId: "clear",
      name: "clear",
      handler: async () => {
        await clearActivePluginRegistry();
        await clearActivePluginRegistry();
        return { text: "cleared" };
      },
    });
    setActivePluginRegistry(registry);
    const dispatch = requirePluginDispatch(
      createPluginCommandRuntime().listNativeCandidates("telegram")[0]!,
    );
    await expect(dispatch.execute(executionContext)).resolves.toEqual({ text: "cleared" });
    await clearActivePluginRegistry();
    expect(cleanupReplacedPluginHostRegistry).toHaveBeenCalledOnce();
  });

  it("awaits cleanup from detached handler context after execution settles", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ status: "loaded" } as never);
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let releaseCleanup!: () => void;
    cleanupReplacedPluginHostRegistry.mockImplementationOnce(
      async () =>
        await new Promise<{ cleanupCount: number; failures: [] }>((resolve) => {
          releaseCleanup = () => resolve({ cleanupCount: 0, failures: [] });
        }),
    );
    let detachedClear!: Promise<void>;
    registerCommand(registry, {
      pluginId: "detached",
      name: "detached",
      handler: () => {
        detachedClear = (async () => {
          await detachedGate;
          await clearActivePluginRegistry();
        })();
        return Promise.resolve({ text: "scheduled" });
      },
    });
    setActivePluginRegistry(registry);
    const dispatch = requirePluginDispatch(
      createPluginCommandRuntime().listNativeCandidates("telegram")[0]!,
    );

    await expect(dispatch.execute(executionContext)).resolves.toEqual({ text: "scheduled" });
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
    releaseDetached();
    await vi.waitFor(() => expect(cleanupReplacedPluginHostRegistry).toHaveBeenCalledOnce());
    let clearSettled = false;
    void detachedClear.then(() => {
      clearSettled = true;
    });
    await Promise.resolve();
    expect(clearSettled).toBe(false);
    releaseCleanup();
    await detachedClear;
    expect(clearSettled).toBe(true);
  });

  it("does not reuse an outer admission for detached nested handler cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ status: "loaded" } as never);
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedClear!: Promise<void>;
    registerCommand(registry, {
      pluginId: "inner",
      name: "inner",
      handler: () => {
        detachedClear = (async () => {
          await detachedGate;
          await clearActivePluginRegistry();
        })();
        return Promise.resolve({ text: "inner" });
      },
    });
    let releaseOuter!: () => void;
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    let outerHolding!: () => void;
    const outerHoldingGate = new Promise<void>((resolve) => {
      outerHolding = resolve;
    });
    const innerDispatchRef: { current?: PluginCommandDispatch } = {};
    registerCommand(registry, {
      pluginId: "outer",
      name: "outer",
      handler: async () => {
        await innerDispatchRef.current!.execute({ ...executionContext, commandBody: "/inner" });
        outerHolding();
        await outerGate;
        return { text: "outer" };
      },
    });
    setActivePluginRegistry(registry);
    const candidates = createPluginCommandRuntime().listNativeCandidates("telegram");
    innerDispatchRef.current = requirePluginDispatch(
      candidates.find((candidate) => candidate.name === "inner")!,
    );
    const outerDispatch = requirePluginDispatch(
      candidates.find((candidate) => candidate.name === "outer")!,
    );

    const running = outerDispatch.execute({ ...executionContext, commandBody: "/outer" });
    await outerHoldingGate;
    expect(getPluginCommandExecutionCount(registry)).toBe(1);
    let clearSettled = false;
    void detachedClear.then(() => {
      clearSettled = true;
    });
    releaseDetached();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(clearSettled).toBe(false);
    releaseOuter();
    await expect(running).resolves.toEqual({ text: "outer" });
    await detachedClear;
    expect(clearSettled).toBe(true);
  });

  it("fails factory creation when no registry generation exists", () => {
    resetPluginRuntimeStateForTest();
    expect(() => createPluginCommandRuntime()).toThrow("requires an active or request-scoped");
  });
});
