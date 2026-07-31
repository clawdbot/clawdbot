// Matrix tests cover thread bindings plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { getSessionBindingService, testing } from "openclaw/plugin-sdk/session-binding-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../runtime.js";
import {
  resolveMatrixStateFilePath,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./client/storage.js";
import type { MatrixAuth, MatrixStoragePaths } from "./client/types.js";
import {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings-shared.js";
import {
  createMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "./thread-bindings.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (_to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$reply" : "$root",
    roomId: "!room:example",
  })),
);
vi.mock("./send.js", () => {
  return {
    sendMessageMatrix: sendMessageMatrixMock,
  };
});

describe("matrix thread bindings", () => {
  let stateDir: string;
  const auth = {
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
  } as const;
  const accountId = "ops";
  const idleTimeoutMs = 24 * 60 * 60 * 1000;
  const matrixClient = {} as never;

  function resetThreadBindingAdapters() {
    testing.resetSessionBindingAdaptersForTests();
    resetMatrixThreadBindingsForTests();
  }

  function currentThreadConversation(params?: {
    conversationId?: string;
    parentConversationId?: string;
  }) {
    return {
      channel: "matrix" as const,
      accountId,
      conversationId: params?.conversationId ?? "$thread",
      parentConversationId: params?.parentConversationId ?? "!room:example",
    };
  }

  function createBindingManager(
    params: {
      auth?: MatrixAuth;
      stateDir?: string;
      idleTimeoutMs?: number;
      maxAgeMs?: number;
      enableSweeper?: boolean;
      logVerboseMessage?: (message: string) => void;
    } = {},
  ) {
    return createMatrixThreadBindingManager({
      cfg: {},
      accountId,
      auth: params.auth ?? auth,
      client: matrixClient,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      idleTimeoutMs: params.idleTimeoutMs ?? idleTimeoutMs,
      maxAgeMs: params.maxAgeMs ?? 0,
      enableSweeper: params.enableSweeper ?? false,
      ...(params.logVerboseMessage ? { logVerboseMessage: params.logVerboseMessage } : {}),
    });
  }

  async function createStaticThreadBindingManager() {
    return createBindingManager();
  }

  async function bindCurrentThread(params?: {
    targetSessionKey?: string;
    conversationId?: string;
    parentConversationId?: string;
    metadata?: { introText?: string };
  }) {
    return getSessionBindingService().bind({
      targetSessionKey: params?.targetSessionKey ?? "agent:ops:subagent:child",
      targetKind: "subagent",
      conversation: currentThreadConversation({
        conversationId: params?.conversationId,
        parentConversationId: params?.parentConversationId,
      }),
      placement: "current",
      ...(params?.metadata ? { metadata: params.metadata } : {}),
    });
  }

  function resolveBindingsFilePath(customStateDir?: string) {
    return resolveMatrixStateFilePath({
      auth,
      env: process.env,
      ...(customStateDir ? { stateDir: customStateDir } : {}),
      filename: "thread-bindings.json",
    });
  }

  function writeAuthStorageMeta(authForMeta: MatrixAuth, storagePaths: MatrixStoragePaths) {
    writeStorageMeta({
      storagePaths,
      homeserver: authForMeta.homeserver,
      userId: authForMeta.userId,
      accountId: authForMeta.accountId,
      deviceId: authForMeta.deviceId ?? null,
    });
  }

  async function readPersistedLastActivityAt(bindingsPath: string) {
    const parsed = await readPersistedBindings(bindingsPath);
    return parsed.bindings?.[0]?.lastActivityAt;
  }

  async function readPersistedBindings(bindingsPath: string) {
    const store = createPluginStateKeyedStoreForTests<{
      accountId?: string;
      conversationId?: string;
      parentConversationId?: string;
      targetSessionKey?: string;
      lastActivityAt?: number;
      boundAt?: number;
    }>("matrix", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(bindingsPath) },
    });
    return {
      version: 1,
      bindings: (await store.entries())
        .map((entry) => entry.value)
        .filter((entry) => entry.accountId === accountId)
        .toSorted((a, b) => (a.boundAt ?? 0) - (b.boundAt ?? 0)) as Array<{
        conversationId?: string;
        parentConversationId?: string;
        targetSessionKey?: string;
        lastActivityAt?: number;
      }>,
    };
  }

  async function expectPersistedThreadBinding(
    bindingsPath: string,
    expected: {
      conversationId: string;
      targetSessionKey: string;
      parentConversationId?: string;
    },
  ) {
    const persisted = await readPersistedBindings(bindingsPath);
    expect(persisted.version).toBe(1);
    expect(persisted.bindings).toHaveLength(1);
    expect(persisted.bindings?.[0]?.conversationId).toBe(expected.conversationId);
    expect(persisted.bindings?.[0]?.parentConversationId).toBe(
      expected.parentConversationId ?? "!room:example",
    );
    expect(persisted.bindings?.[0]?.targetSessionKey).toBe(expected.targetSessionKey);
  }

  function latestSendMessageCall() {
    const call = sendMessageMatrixMock.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected sendMessageMatrix call");
    }
    return call;
  }

  beforeEach(() => {
    stateDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "matrix-thread-bindings-"));
    resetThreadBindingAdapters();
    resetPluginStateStoreForTests();
    sendMessageMatrixMock.mockClear();
    setMatrixRuntime({
      state: {
        openKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests("matrix", options),
        openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateSyncKeyedStoreForTests("matrix", options),
        resolveStateDir: () => stateDir,
      },
    } as PluginRuntime);
  });

  afterEach(() => {
    resetThreadBindingAdapters();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("creates child Matrix thread bindings from a top-level room context", async () => {
    await createMatrixThreadBindingManager({
      cfg: {},
      accountId,
      auth,
      client: matrixClient,
      idleTimeoutMs,
      maxAgeMs: 0,
      enableSweeper: false,
    });

    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "matrix",
        accountId: "ops",
        conversationId: "!room:example",
      },
      placement: "child",
      metadata: {
        introText: "intro root",
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith("room:!room:example", "intro root", {
      cfg: {},
      client: {},
      accountId: "ops",
    });
    expect(binding.conversation).toEqual({
      channel: "matrix",
      accountId: "ops",
      conversationId: "$root",
      parentConversationId: "!room:example",
    });
  });

  it("posts intro messages inside existing Matrix threads for current placement", async () => {
    await createStaticThreadBindingManager();

    const binding = await bindCurrentThread({
      metadata: {
        introText: "intro thread",
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith("room:!room:example", "intro thread", {
      cfg: {},
      client: {},
      accountId: "ops",
      threadId: "$thread",
    });
    const resolved = getSessionBindingService().resolveByConversation({
      channel: "matrix",
      accountId: "ops",
      conversationId: "$thread",
      parentConversationId: "!room:example",
    });
    expect(resolved?.bindingId).toBe(binding.bindingId);
    expect(resolved?.targetSessionKey).toBe("agent:ops:subagent:child");
  });

  it("expires idle bindings via the sweeper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    try {
      await createMatrixThreadBindingManager({
        cfg: {},
        accountId: "ops",
        auth,
        client: {} as never,
        idleTimeoutMs: 1_000,
        maxAgeMs: 0,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:ops:subagent:child",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        placement: "current",
        metadata: {
          introText: "intro thread",
        },
      });

      sendMessageMatrixMock.mockClear();
      await vi.advanceTimersByTimeAsync(61_000);
      await Promise.resolve();

      expect(
        getSessionBindingService().resolveByConversation({
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists expired bindings after a sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    try {
      await createMatrixThreadBindingManager({
        cfg: {},
        accountId: "ops",
        auth,
        client: {} as never,
        idleTimeoutMs: 1_000,
        maxAgeMs: 0,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:ops:subagent:first",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread-1",
          parentConversationId: "!room:example",
        },
        placement: "current",
      });
      await getSessionBindingService().bind({
        targetSessionKey: "agent:ops:subagent:second",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread-2",
          parentConversationId: "!room:example",
        },
        placement: "current",
      });

      const sendCallCount = sendMessageMatrixMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(61_000);

      await vi.waitFor(
        () =>
          expect(sendMessageMatrixMock.mock.calls.length).toBeGreaterThanOrEqual(sendCallCount + 2),
        {
          interval: 10,
          timeout: 1_000,
        },
      );

      await vi.waitFor(
        async () => {
          const persisted = await readPersistedBindings(resolveBindingsFilePath());
          expect(persisted.version).toBe(1);
          expect(persisted.bindings).toEqual([]);
        },
        { interval: 10, timeout: 1_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends threaded farewell messages when bindings are unbound", async () => {
    await createMatrixThreadBindingManager({
      cfg: {},
      accountId: "ops",
      auth,
      client: {} as never,
      idleTimeoutMs: 1_000,
      maxAgeMs: 0,
      enableSweeper: false,
    });

    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      },
      placement: "current",
      metadata: {
        introText: "intro thread",
      },
    });

    sendMessageMatrixMock.mockClear();
    await getSessionBindingService().unbind({
      bindingId: binding.bindingId,
      reason: "idle-expired",
    });

    const [to, message, options] = latestSendMessageCall();
    const sendOptions = options as { cfg?: unknown; accountId?: string; threadId?: string };
    expect(to).toBe("room:!room:example");
    expect(message).toContain("Session ended automatically");
    expect(sendOptions.cfg).toEqual({});
    expect(sendOptions.accountId).toBe("ops");
    expect(sendOptions.threadId).toBe("$thread");
  });

  it("does not reload persisted bindings after the Matrix access token changes while deviceId is unknown", async () => {
    const initialAuth = {
      ...auth,
      accessToken: "token-old",
    };
    const rotatedAuth = {
      ...auth,
      accessToken: "token-new",
    };

    const initialManager = await createBindingManager({ auth: initialAuth });

    await bindCurrentThread();
    const initialStoragePaths = resolveMatrixStoragePaths({
      ...initialAuth,
      env: process.env,
    });
    writeAuthStorageMeta(initialAuth, initialStoragePaths);

    initialManager.stop();
    resetThreadBindingAdapters();

    await createBindingManager({ auth: rotatedAuth });

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBeNull();

    const initialBindingsPath = path.join(initialStoragePaths.rootDir, "thread-bindings.json");
    const rotatedBindingsPath = path.join(
      resolveMatrixStoragePaths({
        ...rotatedAuth,
        env: process.env,
      }).rootDir,
      "thread-bindings.json",
    );
    expect(rotatedBindingsPath).not.toBe(initialBindingsPath);
  });

  it("reloads persisted bindings after the Matrix access token changes when deviceId is known", async () => {
    const initialAuth = {
      ...auth,
      accessToken: "token-old",
      deviceId: "DEVICE123",
    };
    const rotatedAuth = {
      ...auth,
      accessToken: "token-new",
      deviceId: "DEVICE123",
    };

    const initialManager = await createBindingManager({ auth: initialAuth });

    await bindCurrentThread();
    const initialStoragePaths = resolveMatrixStoragePaths({
      ...initialAuth,
      env: process.env,
    });
    writeAuthStorageMeta(initialAuth, initialStoragePaths);
    const initialBindingsPath = path.join(initialStoragePaths.rootDir, "thread-bindings.json");
    await expectPersistedThreadBinding(initialBindingsPath, {
      conversationId: "$thread",
      targetSessionKey: "agent:ops:subagent:child",
    });

    initialManager.stop();
    resetThreadBindingAdapters();

    await createBindingManager({ auth: rotatedAuth });

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      })?.targetSessionKey,
    ).toBe("agent:ops:subagent:child");

    const rotatedBindingsPath = path.join(
      resolveMatrixStoragePaths({
        ...rotatedAuth,
        env: process.env,
      }).rootDir,
      "thread-bindings.json",
    );
    expect(rotatedBindingsPath).toBe(initialBindingsPath);
  });

  it("replaces reused account managers when the bindings stateDir changes", async () => {
    const initialStateDir = stateDir;
    const replacementStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "matrix-thread-bindings-replacement-"),
    );

    const initialManager = await createBindingManager({
      stateDir: initialStateDir,
    });

    await bindCurrentThread();

    const replacementManager = await createBindingManager({
      stateDir: replacementStateDir,
    });

    expect(replacementManager).not.toBe(initialManager);
    expect(replacementManager.listBindings()).toStrictEqual([]);
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBeNull();

    await bindCurrentThread({
      targetSessionKey: "agent:ops:subagent:replacement",
      conversationId: "$thread-2",
    });

    await expectPersistedThreadBinding(resolveBindingsFilePath(replacementStateDir), {
      conversationId: "$thread-2",
      targetSessionKey: "agent:ops:subagent:replacement",
    });
    await expectPersistedThreadBinding(resolveBindingsFilePath(initialStateDir), {
      conversationId: "$thread",
      targetSessionKey: "agent:ops:subagent:child",
    });
  });

  it("updates lifecycle windows by session key and refreshes activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    try {
      const manager = await createMatrixThreadBindingManager({
        cfg: {},
        accountId: "ops",
        auth,
        client: {} as never,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:ops:subagent:child",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        placement: "current",
      });
      const original = manager.listBySessionKey("agent:ops:subagent:child")[0];
      if (original === undefined) {
        throw new Error("expected original matrix thread binding");
      }

      const idleUpdated = setMatrixThreadBindingIdleTimeoutBySessionKey({
        accountId: "ops",
        targetSessionKey: "agent:ops:subagent:child",
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      });
      vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
      const maxAgeUpdated = setMatrixThreadBindingMaxAgeBySessionKey({
        accountId: "ops",
        targetSessionKey: "agent:ops:subagent:child",
        maxAgeMs: 6 * 60 * 60 * 1000,
      });

      expect(idleUpdated).toHaveLength(1);
      expect(idleUpdated[0]?.metadata?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
      expect(maxAgeUpdated).toHaveLength(1);
      expect(maxAgeUpdated[0]?.metadata?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
      expect(maxAgeUpdated[0]?.boundAt).toBe(original.boundAt);
      expect(maxAgeUpdated[0]?.metadata?.lastActivityAt).toBe(
        Date.parse("2026-03-06T12:00:00.000Z"),
      );
      expect(manager.listBySessionKey("agent:ops:subagent:child")[0]?.maxAgeMs).toBe(
        6 * 60 * 60 * 1000,
      );
      expect(manager.listBySessionKey("agent:ops:subagent:child")[0]?.lastActivityAt).toBe(
        Date.parse("2026-03-06T12:00:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the latest touched activity only after the debounce window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    try {
      const manager = await createStaticThreadBindingManager();
      const binding = await bindCurrentThread();

      const bindingsPath = resolveBindingsFilePath();
      const originalLastActivityAt = await readPersistedLastActivityAt(bindingsPath);
      const firstTouchedAt = Date.parse("2026-03-06T10:05:00.000Z");
      const secondTouchedAt = Date.parse("2026-03-06T10:10:00.000Z");

      getSessionBindingService().touch(binding.bindingId, firstTouchedAt);
      getSessionBindingService().touch(binding.bindingId, secondTouchedAt);

      await vi.advanceTimersByTimeAsync(29_000);
      expect(await readPersistedLastActivityAt(bindingsPath)).toBe(originalLastActivityAt);

      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      manager.stop();
      await vi.waitFor(
        async () => {
          expect(await readPersistedLastActivityAt(bindingsPath)).toBe(secondTouchedAt);
        },
        { interval: 1, timeout: 5_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending touch persistence on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    try {
      const manager = await createStaticThreadBindingManager();
      const binding = await bindCurrentThread();
      const touchedAt = Date.parse("2026-03-06T12:00:00.000Z");
      getSessionBindingService().touch(binding.bindingId, touchedAt);

      manager.stop();
      vi.useRealTimers();

      const bindingsPath = resolveBindingsFilePath();
      await vi.waitFor(
        async () => {
          expect(await readPersistedLastActivityAt(bindingsPath)).toBe(touchedAt);
        },
        { interval: 1, timeout: 1_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
