import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAcpSessionEntryMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  readAcpSessionEntryMock.mockImplementation(actual.readAcpSessionEntry);
  return {
    ...actual,
    readAcpSessionEntry: readAcpSessionEntryMock,
  };
});

import {
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  testing,
  createTelegramThreadBindingManager as createTelegramThreadBindingManagerImpl,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
  setTelegramThreadBindingStoreForTest,
} from "./thread-bindings.js";

type ThreadBindingStoreEntry = ReturnType<
  ReturnType<typeof createTelegramThreadBindingManagerImpl>["listBindings"]
>[number];

const TELEGRAM_THREAD_BINDINGS_TEST_CFG = {
  channels: {
    telegram: {
      token: "test-token",
    },
  },
} as OpenClawConfig;

type TelegramThreadBindingManagerParams = Parameters<
  typeof createTelegramThreadBindingManagerImpl
>[0];

function createTelegramThreadBindingManager(
  params: Omit<TelegramThreadBindingManagerParams, "cfg">,
) {
  return createTelegramThreadBindingManagerImpl({
    cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
    ...params,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("telegram thread bindings", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDirOverride: string | undefined;
  let threadBindingStore: PluginStateSyncKeyedStore<ThreadBindingStoreEntry>;

  function createThreadBindingStore(): PluginStateSyncKeyedStore<ThreadBindingStoreEntry> {
    return createPluginStateSyncKeyedStoreForTests("telegram", {
      namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
      maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
    });
  }

  function storedBindings(): ThreadBindingStoreEntry[] {
    return threadBindingStore.entries().map((entry) => entry.value);
  }

  beforeEach(async () => {
    resetPluginStateStoreForTests({ closeDatabase: false });
    threadBindingStore = createThreadBindingStore();
    threadBindingStore.clear();
    setTelegramThreadBindingStoreForTest(threadBindingStore);
    readAcpSessionEntryMock.mockReset();
    const acpRuntime = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
      "openclaw/plugin-sdk/acp-runtime",
    );
    readAcpSessionEntryMock.mockImplementation(acpRuntime.readAcpSessionEntry);
    await testing.resetTelegramThreadBindingsForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await testing.resetTelegramThreadBindingsForTests();
    setTelegramThreadBindingStoreForTest(undefined);
    resetPluginStateStoreForTests();
    if (stateDirOverride) {
      fs.rmSync(stateDirOverride, { recursive: true, force: true });
      stateDirOverride = undefined;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("registers a telegram binding adapter and binds current conversations", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 30_000,
      maxAgeMs: 0,
    });
    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-100200300:topic:77",
      },
      placement: "current",
      metadata: {
        boundBy: "user-1",
      },
    });

    expect(bound.conversation.channel).toBe("telegram");
    expect(bound.conversation.accountId).toBe("work");
    expect(bound.conversation.conversationId).toBe("-100200300:topic:77");
    expect(bound.targetSessionKey).toBe("agent:main:subagent:child-1");
    expect(manager.getByConversationId("-100200300:topic:77")?.boundBy).toBe("user-1");
  });

  it("rejects child placement when conversationId is a bare topic ID with no group context", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    const error = await getSessionBindingService()
      .bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "77",
        },
        placement: "child",
      })
      .then(
        () => undefined,
        (bindError: unknown) => bindError,
      );
    expect((error as { code?: unknown } | undefined)?.code).toBe("BINDING_CREATE_FAILED");
  });

  it("rejects child placement when parentConversationId is also a bare topic ID", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    const error = await getSessionBindingService()
      .bind({
        targetSessionKey: "agent:main:acp:child-acp-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "77",
          parentConversationId: "99",
        },
        placement: "child",
      })
      .then(
        () => undefined,
        (bindError: unknown) => bindError,
      );
    expect((error as { code?: unknown } | undefined)?.code).toBe("BINDING_CREATE_FAILED");
  });

  it("shares binding state across distinct module instances", async () => {
    const bindingsA = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-a",
    );
    const bindingsB = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-b",
    );
    bindingsA.setTelegramThreadBindingStoreForTest(threadBindingStore);
    bindingsB.setTelegramThreadBindingStoreForTest(threadBindingStore);

    await bindingsA.testing.resetTelegramThreadBindingsForTests();

    try {
      const managerA = bindingsA.createTelegramThreadBindingManager({
        cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });
      const managerB = bindingsB.createTelegramThreadBindingManager({
        cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });

      expect(managerB).toBe(managerA);

      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-shared",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "shared-runtime",
          conversationId: "-100200300:topic:44",
        },
        placement: "current",
      });

      expect(
        bindingsB
          .getTelegramThreadBindingManager("shared-runtime")
          ?.getByConversationId("-100200300:topic:44")?.targetSessionKey,
      ).toBe("agent:main:subagent:child-shared");
    } finally {
      await bindingsA.testing.resetTelegramThreadBindingsForTests();
      bindingsA.setTelegramThreadBindingStoreForTest(undefined);
      bindingsB.setTelegramThreadBindingStoreForTest(undefined);
    }
  });

  it("updates lifecycle windows by session key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "1234",
      },
    });
    const original = manager.listBySessionKey("agent:main:subagent:child-1")[0];
    if (!original) {
      throw new Error("expected original subagent thread binding");
    }

    const idleUpdated = setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    const maxAgeUpdated = setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(idleUpdated).toHaveLength(1);
    expect(idleUpdated[0]?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(maxAgeUpdated).toHaveLength(1);
    expect(maxAgeUpdated[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(maxAgeUpdated[0]?.boundAt).toBe(original?.boundAt);
    expect(maxAgeUpdated[0]?.lastActivityAt).toBe(Date.parse("2026-03-06T12:00:00.000Z"));
    expect(manager.listBySessionKey("agent:main:subagent:child-1")[0]?.maxAgeMs).toBe(
      6 * 60 * 60 * 1000,
    );
  });

  it("does not persist lifecycle updates when manager persistence is disabled", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
      accountId: "no-persist",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-2",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "no-persist",
        conversationId: "-100200300:topic:88",
      },
    });

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      idleTimeoutMs: 60 * 60 * 1000,
    });
    setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      maxAgeMs: 2 * 60 * 60 * 1000,
    });

    expect(storedBindings().filter((binding) => binding.accountId === "no-persist")).toStrictEqual(
      [],
    );
  });

  it("persists unbinds before restart so removed bindings do not come back", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;

    createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
    });

    await getSessionBindingService().unbind({
      bindingId: bound.bindingId,
      reason: "test-detach",
    });

    await testing.resetTelegramThreadBindingsForTests();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("8460800771")).toBeUndefined();
  });

  it("persists bindings with json-clean metadata", async () => {
    createTelegramThreadBindingManager({
      accountId: "metadata",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:metadata-child",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "metadata",
        conversationId: "metadata-thread",
      },
      metadata: {
        retained: "yes",
        omitted: undefined,
      },
    });

    await testing.resetTelegramThreadBindingsForTests();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "metadata",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("metadata-thread")?.metadata).toStrictEqual({
      retained: "yes",
    });
    expect(
      storedBindings().find((binding) => binding.accountId === "metadata")?.metadata,
    ).toStrictEqual({
      retained: "yes",
    });
  });

  it("starts with empty bindings when the plugin-state store cannot be read", () => {
    setTelegramThreadBindingStoreForTest({
      ...threadBindingStore,
      entries() {
        throw new Error("state unavailable");
      },
    });

    const manager = createTelegramThreadBindingManager({
      accountId: "read-failure",
      persist: true,
      enableSweeper: false,
    });

    expect(manager.listBindings()).toStrictEqual([]);
  });

  it("cleans up stale ACP bindings before restart routing can reuse them", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;

    createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:acp:stale-1",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "cleanup-me",
      },
    });

    await testing.resetTelegramThreadBindingsForTests();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:stale-1",
      storeSessionKey: "agent:main:acp:stale-1",
      entry: undefined,
      acp: undefined,
      storeReadFailed: false,
    });

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("cleanup-me")).toBeUndefined();
    await testing.resetTelegramThreadBindingsForTests();
    expect(storedBindings().map((binding) => binding.conversationId)).not.toContain("cleanup-me");
  });

  it("keeps plugin-owned bindings when ACP cleanup runs on startup", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;

    createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:still-valid",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "plugin-binding-convo",
      },
    });

    await testing.resetTelegramThreadBindingsForTests();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("plugin-binding-convo")?.targetSessionKey).toBe(
      "plugin-binding:openclaw-codex-app-server:still-valid",
    );
    expect(readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("keeps ACP bindings when the session store cannot be read during startup cleanup", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;

    createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:acp:read-failed",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "keep-on-read-failure",
      },
    });

    await testing.resetTelegramThreadBindingsForTests();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:read-failed",
      storeSessionKey: "agent:main:acp:read-failed",
      entry: undefined,
      acp: undefined,
      storeReadFailed: true,
    });

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("keep-on-read-failure")?.targetSessionKey).toBe(
      "agent:main:acp:read-failed",
    );
  });

  it("flushes pending lifecycle update persists before test reset", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
      accountId: "persist-reset",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-3",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "persist-reset",
        conversationId: "-100200300:topic:99",
      },
    });

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "persist-reset",
      targetSessionKey: "agent:main:subagent:child-3",
      idleTimeoutMs: 90_000,
    });

    await testing.resetTelegramThreadBindingsForTests();

    expect(
      storedBindings().find((binding) => binding.accountId === "persist-reset")?.idleTimeoutMs,
    ).toBe(90_000);
  });

  it("does not leak unhandled rejections when a persist write fails", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const manager = createTelegramThreadBindingManager({
        accountId: "persist-failure",
        persist: true,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-persist-failure",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "persist-failure",
          conversationId: "-100200300:topic:100",
        },
      });

      setTelegramThreadBindingStoreForTest({
        ...threadBindingStore,
        register() {
          throw new Error("persist boom");
        },
      });
      manager.touchConversation("-100200300:topic:100");

      await testing.resetTelegramThreadBindingsForTests();
      await flushMicrotasks();
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
