import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTelegramMessageDispatchReplayKey,
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
} from "./message-dispatch-dedupe.js";

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

afterEach(() => {
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
});
