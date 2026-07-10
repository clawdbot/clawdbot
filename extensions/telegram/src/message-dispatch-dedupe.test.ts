// Telegram tests cover message dispatch dedupe plugin behavior.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTelegramMessageDispatchAccountReplayKey,
  buildTelegramMessageDispatchReplayKey,
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  forgetTelegramMessageDispatchReplay,
  releaseTelegramMessageDispatchReplay,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
  TelegramMessageDispatchReplayForgetError,
  type TelegramMessageDispatchReplayGuard,
} from "./message-dispatch-dedupe.js";

const tempDirs: string[] = [];
let previousStateDir: string | undefined;

function createStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-dispatch-dedupe-"));
  tempDirs.push(dir);
  return dir;
}

function message(params?: { chatId?: number; messageId?: number }): Message {
  return {
    message_id: params?.messageId ?? 42,
    date: 1736380800,
    chat: { id: params?.chatId ?? 1234, type: "private" },
  } as Message;
}

function storedReplayKey(accountId: string, msg: Message): string {
  const key = buildTelegramMessageDispatchReplayKey(msg);
  if (!key) {
    throw new Error("expected replay key");
  }
  return buildTelegramMessageDispatchAccountReplayKey({ accountId, key });
}

function createTestReplayGuard(
  params: {
    commit?: TelegramMessageDispatchReplayGuard["commit"];
    forget?: TelegramMessageDispatchReplayGuard["forget"];
    release?: TelegramMessageDispatchReplayGuard["release"];
  } = {},
): TelegramMessageDispatchReplayGuard {
  return {
    claim: async () => ({ kind: "claimed" }),
    commit: params.commit ?? (async () => true),
    forget: params.forget ?? (async () => true),
    hasRecent: async () => false,
    warmup: async () => 0,
    clearMemory: () => {},
    memorySize: () => 0,
    release: params.release ?? (() => {}),
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = createStateDir();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterEach(() => {
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
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
    const writer = createTelegramMessageDispatchReplayGuard();
    const first = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      msg: message(),
    });

    expect(first).toEqual({
      kind: "claimed",
      key: storedReplayKey("default", message()),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }
    await commitTelegramMessageDispatchReplay({
      guard: writer,
      keys: [first.key],
    });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(
      claimTelegramMessageDispatchReplay({
        guard: reader,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({ kind: "duplicate" });
  });

  it("preserves concurrent commits", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    const keys = Array.from({ length: 400 }, (_, index) =>
      storedReplayKey("default", message({ messageId: index + 1 })),
    );

    await commitTelegramMessageDispatchReplay({
      guard: writer,
      keys,
    });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(reader.warmup(TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE)).resolves.toBe(
      keys.length,
    );
  });

  it("commits replay keys serially before starting the next write", async () => {
    const events: string[] = [];
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    const secondStarted = createDeferred();
    const guard = createTestReplayGuard({
      commit: async (key) => {
        events.push(`start:${key}`);
        if (key === "first") {
          await firstGate.promise;
        } else if (key === "second") {
          secondStarted.resolve();
          await secondGate.promise;
        }
        events.push(`finish:${key}`);
        return true;
      },
    });

    const commit = commitTelegramMessageDispatchReplay({
      guard,
      keys: ["first", "second", "third"],
    });

    expect(events).toEqual(["start:first"]);
    firstGate.resolve();
    await secondStarted.promise;
    expect(events).toEqual(["start:first", "finish:first", "start:second"]);

    secondGate.resolve();
    await commit;
    expect(events).toEqual([
      "start:first",
      "finish:first",
      "start:second",
      "finish:second",
      "start:third",
      "finish:third",
    ]);
  });

  it("propagates per-key disk errors and stops the commit sequence", async () => {
    const diskError = new Error("dedupe disk write failed");
    const commitCalls: string[] = [];
    const guard = createTestReplayGuard({
      commit: async (key, options) => {
        commitCalls.push(key);
        if (key === "second") {
          options?.onDiskError?.(diskError);
        }
        return true;
      },
    });

    await expect(
      commitTelegramMessageDispatchReplay({
        guard,
        keys: ["first", "second", "third"],
        requirePersistent: true,
      }),
    ).rejects.toBe(diskError);
    expect(commitCalls).toEqual(["first", "second"]);
  });

  it("keeps live dispatch commits fail-open on dedupe disk errors", async () => {
    const diskError = new Error("dedupe disk write failed");
    const guard = createTestReplayGuard({
      commit: async (_key, options) => {
        options?.onDiskError?.(diskError);
        return true;
      },
    });

    await expect(
      commitTelegramMessageDispatchReplay({
        guard,
        keys: ["live-message"],
      }),
    ).resolves.toBeUndefined();
  });

  it("rolls back partial multi-key commits after a later disk failure", async () => {
    const diskError = new Error("second key was not persisted");
    const committed = new Set<string>();
    const commitCalls: string[] = [];
    const forgetCalls: string[] = [];
    const releaseCalls: string[] = [];
    const guard = createTestReplayGuard({
      commit: async (key, options) => {
        commitCalls.push(key);
        committed.add(key);
        if (key === "second") {
          options?.onDiskError?.(diskError);
        }
        return true;
      },
      forget: async (key) => {
        forgetCalls.push(key);
        committed.delete(key);
        return true;
      },
      release: (key) => {
        releaseCalls.push(key);
      },
    });
    const keys = ["first", "second", "third"];

    await expect(
      commitTelegramMessageDispatchReplay({ guard, keys, requirePersistent: true }),
    ).rejects.toBe(diskError);

    expect(commitCalls).toEqual(["first", "second"]);
    expect(forgetCalls).toEqual(["first", "second"]);
    expect(releaseCalls).toEqual(["third"]);
    expect([...committed]).toEqual([]);
  });

  it("uses one persisted namespace across Telegram accounts", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    const first = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      msg: message(),
    });
    const second = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "work",
      msg: message(),
    });
    if (first.kind !== "claimed" || second.kind !== "claimed") {
      throw new Error("expected account claims");
    }

    await commitTelegramMessageDispatchReplay({
      guard: writer,
      keys: [first.key, second.key],
    });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(reader.warmup(TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE)).resolves.toBe(2);
    await expect(reader.warmup("default")).resolves.toBe(0);
  });

  it("keeps accounts isolated and releases retryable pre-dispatch claims", async () => {
    const guard = createTelegramMessageDispatchReplayGuard();
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
      key: storedReplayKey("work", message()),
    });

    releaseTelegramMessageDispatchReplay({
      guard,
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
    const guard = createTelegramMessageDispatchReplayGuard();
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
      keys: [first.key],
      error: new Error("retry"),
    });

    await expect(duplicate).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });
  });

  it("fails rollback when a committed dispatch key cannot be forgotten", async () => {
    const guard = {
      claim: async () => ({ kind: "claimed" }),
      commit: async () => true,
      forget: async (key: string) => key !== "failed-key",
      hasRecent: async () => false,
      warmup: async () => 0,
      clearMemory: () => {},
      memorySize: () => 0,
      release: () => {},
    } satisfies TelegramMessageDispatchReplayGuard;

    await expect(
      forgetTelegramMessageDispatchReplay({
        guard,
        keys: ["ok-key", "failed-key", "failed-key"],
      }),
    ).rejects.toMatchObject({
      name: TelegramMessageDispatchReplayForgetError.name,
      failures: [{ key: "failed-key" }],
    });
  });
});
