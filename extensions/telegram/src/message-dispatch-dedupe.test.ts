import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
  buildTelegramMessageDispatchReplayKey,
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
  setTelegramMessageDispatchDedupeStoreForTest,
} from "./message-dispatch-dedupe.js";

type MessageDispatchDedupeStore = NonNullable<
  Parameters<typeof setTelegramMessageDispatchDedupeStoreForTest>[0]
>;
type SyncMessageDispatchDedupeStore = Extract<MessageDispatchDedupeStore, { entries(): unknown[] }>;

const tempDirs: string[] = [];

function createStorePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-dispatch-dedupe-"));
  tempDirs.push(dir);
  return path.join(dir, "sessions.json");
}

function message(params?: { chatId?: number; messageId?: number }): Message {
  return {
    message_id: params?.messageId ?? 42,
    date: 1736380800,
    chat: { id: params?.chatId ?? 1234, type: "private" },
  } as Message;
}

beforeEach(async () => {
  resetPluginStateStoreForTests({ closeDatabase: false });
  const store = createPluginStateKeyedStoreForTests("telegram", {
    namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
    maxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
  }) as NonNullable<Parameters<typeof setTelegramMessageDispatchDedupeStoreForTest>[0]>;
  await store.clear();
  setTelegramMessageDispatchDedupeStoreForTest(store);
});

afterEach(() => {
  setTelegramMessageDispatchDedupeStoreForTest(undefined);
  resetPluginStateStoreForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Telegram message dispatch replay guard", () => {
  it("keys messages by chat id and message id", () => {
    expect(buildTelegramMessageDispatchReplayKey(message())).toBe(
      JSON.stringify(["message", "1234", 42]),
    );
    expect(buildTelegramMessageDispatchReplayKey(message({ messageId: 0 }))).toBeNull();
  });

  it("persists committed dispatches across guard recreation", async () => {
    const storePath = createStorePath();
    const writer = createTelegramMessageDispatchReplayGuard({ storePath });
    const first = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      msg: message(),
    });

    expect(first).toEqual({
      kind: "claimed",
      key: JSON.stringify(["message", "1234", 42]),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }
    await commitTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      keys: [first.key],
    });

    const reader = createTelegramMessageDispatchReplayGuard({ storePath });
    await expect(
      claimTelegramMessageDispatchReplay({
        guard: reader,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({ kind: "duplicate" });
  });

  it("preserves concurrent commits that share dedupe buckets", async () => {
    const storePath = createStorePath();
    const writer = createTelegramMessageDispatchReplayGuard({ storePath });
    const keys = Array.from({ length: 400 }, (_, index) =>
      JSON.stringify(["message", "1234", index + 1]),
    );

    await commitTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      keys,
    });

    const reader = createTelegramMessageDispatchReplayGuard({ storePath });
    await expect(reader.warmup("default")).resolves.toBe(keys.length);
  });

  it("falls back to same-process replay protection when plugin-state cannot open", async () => {
    setTelegramMessageDispatchDedupeStoreForTest(undefined);
    const errors: unknown[] = [];
    const storePath = createStorePath();
    const guard = createTelegramMessageDispatchReplayGuard({
      storePath,
      onDiskError: (error) => errors.push(error),
    });
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }

    await expect(guard.commit(first.key, { namespace: "default" })).resolves.toBe(false);

    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({ kind: "duplicate" });
    await expect(guard.hasRecent(first.key, { namespace: "default" })).resolves.toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("keeps same-process replay protection when plugin-state commit fails", async () => {
    const failingStore = createPluginStateKeyedStoreForTests("telegram", {
      namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
    }) as NonNullable<Parameters<typeof setTelegramMessageDispatchDedupeStoreForTest>[0]>;
    setTelegramMessageDispatchDedupeStoreForTest({
      ...failingStore,
      async register() {
        throw new Error("state write failed");
      },
    });
    const storePath = createStorePath();
    const guard = createTelegramMessageDispatchReplayGuard({ storePath });
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }

    await expect(guard.commit(first.key, { namespace: "default" })).resolves.toBe(false);

    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({ kind: "duplicate" });
    await expect(guard.hasRecent(first.key, { namespace: "default" })).resolves.toBe(true);
    await expect(guard.warmup("default")).resolves.toBe(1);
  });

  it("keeps same-process replay protection when lookup fails after a successful commit", async () => {
    const backingStore = createPluginStateSyncKeyedStoreForTests("telegram", {
      namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
    }) as SyncMessageDispatchDedupeStore;
    let failLookup = false;
    setTelegramMessageDispatchDedupeStoreForTest({
      ...backingStore,
      lookup(key) {
        if (failLookup) {
          throw new Error("state read failed");
        }
        return backingStore.lookup(key);
      },
    });
    const storePath = createStorePath();
    const guard = createTelegramMessageDispatchReplayGuard({ storePath });
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }
    await expect(guard.commit(first.key, { namespace: "default" })).resolves.toBe(true);

    failLookup = true;

    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({ kind: "duplicate" });
  });

  it("keeps replay histories isolated by session store path", async () => {
    const firstStorePath = createStorePath();
    const secondStorePath = createStorePath();
    const firstGuard = createTelegramMessageDispatchReplayGuard({
      storePath: firstStorePath,
    });
    const first = await claimTelegramMessageDispatchReplay({
      guard: firstGuard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }
    await commitTelegramMessageDispatchReplay({
      guard: firstGuard,
      accountId: "default",
      keys: [first.key],
    });

    const secondGuard = createTelegramMessageDispatchReplayGuard({
      storePath: secondStorePath,
    });
    await expect(
      claimTelegramMessageDispatchReplay({
        guard: secondGuard,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });
  });

  it("keeps accounts isolated and releases retryable pre-dispatch claims", async () => {
    const storePath = createStorePath();
    const guard = createTelegramMessageDispatchReplayGuard({ storePath });
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }

    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "work",
        msg: message(),
      }),
    ).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });

    releaseTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      keys: [first.key],
    });
    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });
  });

  it("lets an in-flight duplicate retry after the first claim is released", async () => {
    const storePath = createStorePath();
    const guard = createTelegramMessageDispatchReplayGuard({ storePath });
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }

    const duplicate = claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    releaseTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      keys: [first.key],
      error: new Error("retry"),
    });

    await expect(duplicate).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });
  });
});
