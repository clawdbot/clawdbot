// Telegram tests cover message dispatch dedupe plugin behavior.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTelegramMessageDispatchAccountReplayKey,
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
} from "./message-dispatch-dedupe.js";

type TelegramMessageDispatchReplayGuard = Parameters<
  typeof claimTelegramMessageDispatchReplay
>[0]["guard"];

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
  const key = JSON.stringify(["message", String(msg.chat.id), msg.message_id]);
  return buildTelegramMessageDispatchAccountReplayKey({ accountId, key });
}

function createTestReplayGuard(
  params: {
    forget?: (
      key: string,
      options?: Parameters<TelegramMessageDispatchReplayGuard["forget"]>[1],
    ) => Promise<boolean>;
  } = {},
): TelegramMessageDispatchReplayGuard {
  const eventKey = (event: Parameters<TelegramMessageDispatchReplayGuard["forget"]>[0]): string =>
    "keys" in event ? (event.keys?.[0] ?? "") : "";
  return {
    claim: async () => ({ kind: "invalid" }),
    forget: async (event, options) =>
      await (params.forget ?? (async () => true))(eventKey(event), options),
    warmup: async () => 0,
  };
}

function createTestClaim(params: {
  key: string;
  commit?: (
    key: string,
    options?: Parameters<ChannelReplayClaimHandle["commit"]>[0],
  ) => Promise<boolean>;
  release?: (key: string, options?: { error?: unknown }) => void;
}): ChannelReplayClaimHandle {
  return {
    keys: [params.key],
    commit: async (options) => await (params.commit ?? (async () => true))(params.key, options),
    release: (options) => (params.release ?? (() => {}))(params.key, options),
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
  it("persists committed dispatches across guard recreation", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    const first = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      msg: message(),
    });

    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }
    expect(first.handle.keys).toEqual([storedReplayKey("default", message())]);
    await commitTelegramMessageDispatchReplay({
      guard: writer,
      claims: [first.handle],
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
    const claims = await Promise.all(
      Array.from({ length: 400 }, async (_, index) => {
        const claim = await claimTelegramMessageDispatchReplay({
          guard: writer,
          accountId: "default",
          msg: message({ messageId: index + 1 }),
        });
        if (claim.kind !== "claimed") {
          throw new Error(`expected claim ${index + 1}`);
        }
        return claim.handle;
      }),
    );

    await commitTelegramMessageDispatchReplay({
      guard: writer,
      claims,
    });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(reader.warmup(TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE)).resolves.toBe(
      claims.length,
    );
  });

  it("commits replay keys serially before starting the next write", async () => {
    const events: string[] = [];
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    const secondStarted = createDeferred();
    const guard = createTestReplayGuard();
    const claims = ["first", "second", "third"].map((key) =>
      createTestClaim({
        key,
        commit: async (keyLocal) => {
          events.push(`start:${keyLocal}`);
          if (keyLocal === "first") {
            await firstGate.promise;
          } else if (keyLocal === "second") {
            secondStarted.resolve();
            await secondGate.promise;
          }
          events.push(`finish:${keyLocal}`);
          return true;
        },
      }),
    );

    const commit = commitTelegramMessageDispatchReplay({
      guard,
      claims,
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
    const guard = createTestReplayGuard();
    const claims = ["first", "second", "third"].map((key) =>
      createTestClaim({
        key,
        commit: async (keyLocal, options) => {
          commitCalls.push(keyLocal);
          if (keyLocal === "second") {
            options?.onDiskError?.(diskError);
          }
          return true;
        },
      }),
    );

    await expect(
      commitTelegramMessageDispatchReplay({
        guard,
        claims,
        requirePersistent: true,
      }),
    ).rejects.toBe(diskError);
    expect(commitCalls).toEqual(["first", "second"]);
  });

  it("keeps live dispatch commits fail-open on dedupe disk errors", async () => {
    const diskError = new Error("dedupe disk write failed");
    const guard = createTestReplayGuard();
    const claim = createTestClaim({
      key: "live-message",
      commit: async (_key, options) => {
        options?.onDiskError?.(diskError);
        return true;
      },
    });

    await expect(
      commitTelegramMessageDispatchReplay({
        guard,
        claims: [claim],
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
      forget: async (key) => {
        forgetCalls.push(key);
        committed.delete(key);
        return true;
      },
    });
    const keys = ["first", "second", "third"];
    const claims = keys.map((key) =>
      createTestClaim({
        key,
        commit: async (keyLocal, options) => {
          commitCalls.push(keyLocal);
          committed.add(keyLocal);
          if (keyLocal === "second") {
            options?.onDiskError?.(diskError);
          }
          return true;
        },
        release: (keyLocal) => {
          releaseCalls.push(keyLocal);
        },
      }),
    );

    await expect(
      commitTelegramMessageDispatchReplay({ guard, claims, requirePersistent: true }),
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
      claims: [first.handle, second.handle],
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

    const work = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "work",
      msg: message(),
    });
    expect(work.kind).toBe("claimed");
    if (work.kind === "claimed") {
      expect(work.handle.keys).toEqual([storedReplayKey("work", message())]);
    }

    releaseTelegramMessageDispatchReplay({
      claims: [first.handle],
    });
    const retry = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    expect(retry.kind).toBe("claimed");
    if (retry.kind === "claimed") {
      expect(retry.handle.keys).toEqual(first.handle.keys);
    }
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
      claims: [first.handle],
      error: new Error("retry"),
    });

    const retry = await duplicate;
    expect(retry.kind).toBe("claimed");
    if (retry.kind === "claimed") {
      expect(retry.handle.keys).toEqual(first.handle.keys);
    }
  });
});
