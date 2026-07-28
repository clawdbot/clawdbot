import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Imessage tests cover unknown-send reconciliation for durable delivery (#115328).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileIMessageUnknownSend, resolveLatestSentMessageGuidFromChatDb } from "./send.js";

const IMESSAGE_TEST_CFG = {
  channels: {
    imessage: {
      accounts: {
        default: {},
      },
    },
  },
} as unknown as OpenClawConfig;

function createCtx(overrides?: Partial<ChannelMessageUnknownSendContext>) {
  return {
    cfg: IMESSAGE_TEST_CFG,
    queueId: "queue-1",
    channel: "imessage",
    to: "chat_id:42",
    enqueuedAt: 1_000_000,
    retryCount: 0,
    payloads: [{ text: "hello from the grid" }],
    ...overrides,
  } satisfies ChannelMessageUnknownSendContext;
}

describe("reconcileIMessageUnknownSend", () => {
  it("acks the delivery as sent when chat.db yields a matching guid", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/guid-1");
    const result = await reconcileIMessageUnknownSend(createCtx(), {
      resolveSentMessageGuidImpl,
    });
    expect(result?.status).toBe("sent");
    if (result?.status === "sent") {
      expect(result.messageId).toBe("p:0/guid-1");
      expect(result.receipt).toBeDefined();
    }
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: expect.anything(),
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: "hello from the grid",
      sentAfterMs: 1_000_000 - 5_000,
    });
  });

  it("prefers platformSendStartedAt over enqueuedAt for the lookup window", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/guid-2");
    await reconcileIMessageUnknownSend(createCtx({ platformSendStartedAt: 2_000_000 }), {
      resolveSentMessageGuidImpl,
    });
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith(
      expect.objectContaining({ sentAfterMs: 2_000_000 - 5_000 }),
    );
  });

  it("stays fail-closed as retryable unresolved when no matching row exists", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const result = await reconcileIMessageUnknownSend(createCtx(), {
      resolveSentMessageGuidImpl,
    });
    expect(result).toEqual({
      status: "unresolved",
      error: expect.stringContaining("no matching is_from_me iMessage row"),
      retryable: true,
    });
  });

  it("requires every payload in the batch to match before acking", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async (params: { text: string }) =>
      params.text === "first" ? "p:0/guid-first" : null,
    );
    const result = await reconcileIMessageUnknownSend(
      createCtx({ payloads: [{ text: "first" }, { text: "second" }] }),
      { resolveSentMessageGuidImpl },
    );
    expect(result?.status).toBe("unresolved");
  });

  it("acks multi-payload batches when every payload matches", async () => {
    const resolveSentMessageGuidImpl = vi.fn(
      async (params: { text: string }) => `p:0/guid-${params.text}`,
    );
    const result = await reconcileIMessageUnknownSend(
      createCtx({ payloads: [{ text: "first" }, { text: "second" }] }),
      { resolveSentMessageGuidImpl },
    );
    expect(result?.status).toBe("sent");
    if (result?.status === "sent") {
      expect(result.messageId).toBe("p:0/guid-second");
    }
  });

  it("returns null for media-bearing payloads (not provable via text lookup)", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/guid-1");
    const result = await reconcileIMessageUnknownSend(
      createCtx({ payloads: [{ text: "caption", mediaUrl: "https://example.com/x.png" }] }),
      { resolveSentMessageGuidImpl },
    );
    expect(result).toBeNull();
    expect(resolveSentMessageGuidImpl).not.toHaveBeenCalled();
  });

  it("reports unresolved when chat.db is unavailable (remote cliPath wrapper)", async () => {
    const result = await reconcileIMessageUnknownSend(
      createCtx({
        cfg: {
          channels: {
            imessage: {
              accounts: {
                default: { cliPath: "/opt/remote-imsg-ssh" },
              },
            },
          },
        } as unknown as OpenClawConfig,
      }),
    );
    expect(result).toEqual({
      status: "unresolved",
      error: expect.stringContaining("requires a readable chat.db"),
      retryable: true,
    });
  });
});

describe("resolveLatestSentMessageGuidFromChatDb false-match hardening", () => {
  const APPLE_EPOCH_UNIX_MS = 978_307_200_000;
  const ATTEMPT_START_MS = 1_700_000_000_000;
  // reconcileIMessageUnknownSend passes attemptStart - 5s clock-skew allowance.
  const SENT_AFTER_MS = ATTEMPT_START_MS - 5_000;
  const CHAT_ID = 42;

  let tempDir = "";
  let dbPath = "";

  const appleDateNs = (unixMs: number) => BigInt(unixMs - APPLE_EPOCH_UNIX_MS) * 1_000_000n;

  const insertSentMessage = (params: {
    rowId: number;
    guid: string;
    text: string;
    unixMs: number;
  }) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "INSERT INTO message(ROWID, guid, text, is_from_me, date, handle_id) VALUES (?, ?, ?, 1, ?, NULL)",
      ).run(params.rowId, params.guid, params.text, appleDateNs(params.unixMs));
      db.prepare("INSERT INTO chat_message_join(chat_id, message_id) VALUES (?, ?)").run(
        CHAT_ID,
        params.rowId,
      );
    } finally {
      db.close();
    }
  };

  const resolveGuid = (text: string) =>
    resolveLatestSentMessageGuidFromChatDb({
      dbPath,
      target: { kind: "chat_id", chatId: CHAT_ID } as Parameters<
        typeof resolveLatestSentMessageGuidFromChatDb
      >[0]["target"],
      text,
      sentAfterMs: SENT_AFTER_MS,
    });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imessage-reconcile-"));
    dbPath = path.join(tempDir, "chat.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, is_from_me INTEGER, date INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, uncanonicalized_id TEXT);
      INSERT INTO chat(ROWID, chat_identifier, guid) VALUES
        (${CHAT_ID}, '+15550001111', 'iMessage;-;+15550001111');
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves the guid when exactly one matching row exists inside the attempt window", () => {
    insertSentMessage({
      rowId: 1,
      guid: "p:0/new-guid",
      text: "hello from the grid",
      unixMs: ATTEMPT_START_MS + 1_000,
    });
    expect(resolveGuid("hello from the grid")).toBe("p:0/new-guid");
  });

  it("does not match an identical older row that predates the send attempt", () => {
    insertSentMessage({
      rowId: 1,
      guid: "p:0/old-guid",
      text: "hello from the grid",
      unixMs: ATTEMPT_START_MS - 120_000,
    });
    expect(resolveGuid("hello from the grid")).toBeNull();
  });

  it("matches the in-window row even when an identical older row exists before the attempt", () => {
    insertSentMessage({
      rowId: 1,
      guid: "p:0/old-guid",
      text: "hello from the grid",
      unixMs: ATTEMPT_START_MS - 120_000,
    });
    insertSentMessage({
      rowId: 2,
      guid: "p:0/new-guid",
      text: "hello from the grid",
      unixMs: ATTEMPT_START_MS + 1_000,
    });
    expect(resolveGuid("hello from the grid")).toBe("p:0/new-guid");
  });

  it("fails closed when duplicate identical rows exist inside the attempt window", () => {
    insertSentMessage({
      rowId: 1,
      guid: "p:0/first-guid",
      text: "hello from the grid",
      unixMs: ATTEMPT_START_MS + 1_000,
    });
    insertSentMessage({
      rowId: 2,
      guid: "p:0/second-guid",
      text: "hello from the grid",
      unixMs: ATTEMPT_START_MS + 2_000,
    });
    expect(resolveGuid("hello from the grid")).toBeNull();
  });

  it("does not match rows from other chats", () => {
    insertSentMessage({
      rowId: 1,
      guid: "p:0/other-chat-guid",
      text: "hello from the grid",
      unixMs: ATTEMPT_START_MS + 1_000,
    });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE chat_message_join SET chat_id = 7 WHERE message_id = 1").run();
    } finally {
      db.close();
    }
    expect(resolveGuid("hello from the grid")).toBeNull();
  });
});
