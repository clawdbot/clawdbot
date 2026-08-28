import path from "node:path";
import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { clearConfigCache } from "../config/config.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceTranscriptEvents,
  SessionTranscriptProjectionUnavailableError,
} from "../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-delta.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as managedOutgoingMedia from "./managed-image-attachments.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { installGatewayTestHooks, testState, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ChatMethod = "chat.history" | "chat.startup";
type RpcResult<T = Record<string, unknown>> = {
  error?: unknown;
  ok: boolean;
  payload?: T;
};

const sessionKey = "agent:main:main";
const sessionId = "cursor-session";

function transcriptEvent(params: {
  content: unknown;
  id: string;
  parentId: string | null;
  role: string;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: params.role,
      content: params.content,
      timestamp: Date.now(),
    },
  };
}

function currentScope(storePath: string) {
  return { agentId: "main", sessionId, sessionKey, storePath };
}

async function createCursorSession(initialEvents?: unknown[]) {
  const directory = tempDirs.make("openclaw-history-cursor-");
  const storePath = path.join(directory, "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {
      main: { sessionId, updatedAt: Date.now() },
    },
  });
  await replaceTranscriptEvents(
    currentScope(storePath),
    (initialEvents ?? [
      transcriptEvent({
        content: "cached",
        id: "cached",
        parentId: null,
        role: "user",
      }),
    ]) as Parameters<typeof replaceTranscriptEvents>[1],
  );
  return { context: createDirectChatContext(), storePath };
}

async function callChat<T extends Record<string, unknown>>(
  context: GatewayRequestContext,
  method: ChatMethod,
  params: Record<string, unknown> = {},
): Promise<RpcResult<T>> {
  const { chatHandlers } = await import("./server-methods/chat.js");
  const result: RpcResult<T> = { ok: false };
  await chatHandlers[method]?.({
    client: null,
    context,
    isWebchatConnect: () => false,
    params: { sessionKey: "main", ...params },
    req: { id: method, method, params, type: "req" },
    respond: (ok, payload, error) => {
      result.ok = ok;
      result.payload = payload as T | undefined;
      result.error = error;
    },
  });
  return result;
}

function renderedMessages(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return message;
    }
    const record = message as Record<string, unknown>;
    const metadata = record["__openclaw"];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return record;
    }
    const { recordTimestampMs: _recordTimestampMs, ...visibleMetadata } = metadata as Record<
      string,
      unknown
    >;
    return { ...record, __openclaw: visibleMetadata };
  });
}

afterEach(() => {
  testState.sessionStorePath = undefined;
  clearConfigCache();
});

describe("chat.history cursor catch-up", () => {
  test.each(["chat.history", "chat.startup"] as const)(
    "%s does not launch managed outgoing media garbage collection",
    async (method) => {
      const { context } = await createCursorSession();
      const cleanup = vi
        .spyOn(managedOutgoingMedia, "cleanupManagedOutgoingMediaRecords")
        .mockResolvedValue({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });

      try {
        const result = await callChat(context, method);

        expect(result.ok).toBe(true);
        expect(cleanup).not.toHaveBeenCalled();
      } finally {
        cleanup.mockRestore();
      }
    },
  );

  test("returns an empty delta at the cached head", async () => {
    const { context } = await createCursorSession();
    const page = await callChat<{ deltaCursor?: string; messages?: unknown[] }>(
      context,
      "chat.history",
    );
    expect(page.ok).toBe(true);
    expect(page.payload?.deltaCursor).toEqual(expect.any(String));
    const explicitFirstPage = await callChat<{ deltaCursor?: string }>(context, "chat.history", {
      offset: 0,
    });
    expect(explicitFirstPage.payload?.deltaCursor).toEqual(expect.any(String));

    const delta = await callChat<{
      deltaCursor?: string;
      kind?: string;
      messages?: unknown[];
      sessionInfo?: { activeLeafEntryId?: string | null };
    }>(context, "chat.history", { cursor: page.payload?.deltaCursor });
    expect(delta).toMatchObject({
      ok: true,
      payload: {
        kind: "delta",
        messages: [],
        deltaCursor: page.payload?.deltaCursor,
        sessionInfo: { activeLeafEntryId: "cached" },
      },
    });
  });

  test.each(["chat.history", "chat.startup"] as const)(
    "%s returns the active run snapshot with an empty cached delta",
    async (method) => {
      const { context } = await createCursorSession();
      context.chatAbortControllers.set("run-active", {
        controller: new AbortController(),
        sessionId,
        sessionKey: "main",
        startedAtMs: 1_000,
        expiresAtMs: Date.now() + 60_000,
        projectSessionActive: true,
      });
      context.chatRunState.getOrCreate("run-active").buffer = "still working";
      const page = await callChat<{ deltaCursor?: string }>(context, method);

      const delta = await callChat<{
        inFlightRun?: unknown;
        kind?: string;
        messages?: unknown[];
      }>(context, method, { cursor: page.payload?.deltaCursor });

      expect(delta).toMatchObject({
        ok: true,
        payload: {
          kind: "delta",
          messages: [],
          inFlightRun: {
            runId: "run-active",
            text: "still working",
            startedAt: 1_000,
          },
        },
      });
    },
  );

  test("does not advance a cursor past messages appended after the projection check", async () => {
    const { context, storePath } = await createCursorSession();
    const scope = currentScope(storePath);
    const cached = await callChat<{ deltaCursor?: string }>(context, "chat.history");
    const cursor = cached.payload?.deltaCursor;
    if (!cursor) {
      throw new Error("expected cached history cursor");
    }
    const resolved = resolveSqliteTranscriptReadScope(scope);
    const databaseOptions = toDatabaseOptions(resolved);
    const database = openOpenClawAgentDatabase(databaseOptions);
    const indexed = asOptionalRecord(
      database.db
        .prepare("SELECT indexed_seq FROM session_transcript_index_state WHERE session_id = ?")
        .get(sessionId),
    );
    const indexedSeq = indexed?.indexed_seq;
    if (typeof indexedSeq !== "number") {
      throw new Error("expected current transcript projection");
    }
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(database.path);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;");
    let appended = false;
    const limits = {
      cursor,
      maxBytes: 1_000_000,
      get maxEvents() {
        if (appended) {
          return 200;
        }
        appended = true;
        const nextSeq = indexedSeq + 1;
        const events = [
          transcriptEvent({
            content: "missed user",
            id: "missed-user",
            parentId: "cached",
            role: "user",
          }),
          transcriptEvent({
            content: "missed assistant",
            id: "missed-assistant",
            parentId: "missed-user",
            role: "assistant",
          }),
        ];
        writer.exec("BEGIN IMMEDIATE;");
        try {
          const insertEvent = writer.prepare(
            "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
          );
          const insertIdentity = writer.prepare(
            `INSERT INTO transcript_event_identities
               (session_id, event_id, seq, event_type, parent_id,
                message_idempotency_key, created_at)
             VALUES (?, ?, ?, 'message', ?, NULL, ?)`,
          );
          for (const [offset, event] of events.entries()) {
            const seq = nextSeq + offset;
            insertEvent.run(sessionId, seq, JSON.stringify(event), Date.now());
            insertIdentity.run(sessionId, event.id, seq, event.parentId, Date.now());
          }
          writer.exec("COMMIT;");
        } catch (error) {
          writer.exec("ROLLBACK;");
          throw error;
        }
        return 200;
      },
    };

    try {
      expect(() => readTranscriptDisplayDelta(scope, limits)).toThrow(
        SessionTranscriptProjectionUnavailableError,
      );
    } finally {
      writer.close();
    }
    await waitForSessionTranscriptIndexReconcile(databaseOptions);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recovered = await callChat<{
        kind?: string;
        messages?: Array<{ message?: { content?: unknown } }>;
      }>(context, "chat.history", { cursor });
      expect(recovered).toMatchObject({
        ok: true,
        payload: {
          kind: "delta",
          messages: [
            { message: { content: "missed user" } },
            { message: { content: "missed assistant" } },
          ],
        },
      });
    }
  });

  test.each([
    {
      name: "plain messages",
      append: async (storePath: string) => {
        const user = await appendTranscriptMessage(currentScope(storePath), {
          eventId: "user-2",
          parentId: "cached",
          message: { role: "user", content: "question", timestamp: 2 },
        });
        await appendTranscriptMessage(currentScope(storePath), {
          eventId: "assistant-2",
          parentId: user?.messageId,
          message: { role: "assistant", content: "answer", timestamp: 3 },
        });
      },
    },
    {
      name: "tool result pairing",
      append: async (storePath: string) => {
        const call = await appendTranscriptMessage(currentScope(storePath), {
          eventId: "assistant-tool",
          parentId: "cached",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
            timestamp: 2,
          },
        });
        await appendTranscriptMessage(currentScope(storePath), {
          eventId: "tool-result",
          parentId: call?.messageId,
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "result" }],
            timestamp: 3,
          },
        });
      },
    },
    {
      name: "heartbeat boundary",
      append: async (storePath: string) => {
        const heartbeat = await appendTranscriptMessage(currentScope(storePath), {
          eventId: "heartbeat-user",
          parentId: "cached",
          message: { role: "user", content: HEARTBEAT_PROMPT, timestamp: 2 },
        });
        const acknowledged = await appendTranscriptMessage(currentScope(storePath), {
          eventId: "heartbeat-ok",
          parentId: heartbeat?.messageId,
          message: { role: "assistant", content: "HEARTBEAT_OK", timestamp: 3 },
        });
        await appendTranscriptMessage(currentScope(storePath), {
          eventId: "after-heartbeat",
          parentId: acknowledged?.messageId,
          message: { role: "user", content: "after heartbeat", timestamp: 4 },
        });
      },
    },
    {
      name: "hidden and silent events",
      append: async (storePath: string) => {
        await appendTranscriptEvent(currentScope(storePath), {
          id: "hidden-control",
          parentId: "cached",
          type: "custom",
        });
        const silent = await appendTranscriptMessage(currentScope(storePath), {
          eventId: "silent",
          parentId: "hidden-control",
          message: { role: "assistant", content: "NO_REPLY", timestamp: 3 },
        });
        await appendTranscriptMessage(currentScope(storePath), {
          eventId: "visible-after-hidden",
          parentId: silent?.messageId,
          message: { role: "assistant", content: "visible", timestamp: 4 },
        });
      },
    },
  ])("replays $name to the same rendered tail", async ({ append, name }) => {
    const { context, storePath } = await createCursorSession();
    const cached = await callChat<{ deltaCursor?: string; messages?: unknown[] }>(
      context,
      "chat.history",
    );
    await append(storePath);

    const delta = await callChat<{
      deltaCursor?: string;
      kind?: string;
      messages?: Array<{ message?: unknown; messageId?: unknown; messageSeq?: unknown }>;
    }>(context, "chat.history", { cursor: cached.payload?.deltaCursor });
    expect(delta.ok).toBe(true);
    expect(delta.payload?.kind).toBe("delta");
    if (name === "tool result pairing") {
      expect(delta.payload?.messages?.at(-1)?.message).toMatchObject({
        role: "toolResult",
        toolCallId: "call-1",
      });
    }

    let projection = createSessionProjection(
      { sessionId, sessionKey },
      cached.payload?.messages ?? [],
    );
    for (const envelope of delta.payload?.messages ?? []) {
      projection = reduceSessionProjection(projection, {
        type: "messagePersisted",
        message: envelope.message,
        envelope,
        sessionId,
        sessionKey,
      });
    }
    const fresh = await callChat<{ messages?: unknown[] }>(context, "chat.history");
    expect(renderedMessages(projection.messages)).toEqual(
      renderedMessages(fresh.payload?.messages ?? []),
    );
  });

  test.each([
    { name: "garbage cursor", prepare: async () => "garbage" },
    {
      name: "different session cursor",
      prepare: async (context: GatewayRequestContext, storePath: string) => {
        const otherScope = {
          agentId: "main",
          sessionId: "other-session",
          sessionKey: "agent:main:other",
          storePath,
        };
        await replaceTranscriptEvents(otherScope, [
          transcriptEvent({ content: "other", id: "other", parentId: null, role: "user" }),
        ]);
        await writeSessionStore({
          entries: {
            main: { sessionId, updatedAt: Date.now() },
            other: { sessionId: "other-session", updatedAt: Date.now() },
          },
        });
        const page = await callChat<{ deltaCursor?: string }>(context, "chat.history", {
          sessionKey: "other",
        });
        return page.payload?.deltaCursor;
      },
    },
    {
      name: "generation replacement",
      prepare: async (context: GatewayRequestContext, storePath: string) => {
        const page = await callChat<{ deltaCursor?: string }>(context, "chat.history");
        await replaceTranscriptEvents(currentScope(storePath), [
          transcriptEvent({
            content: "replacement",
            id: "replacement",
            parentId: null,
            role: "user",
          }),
        ]);
        return page.payload?.deltaCursor;
      },
    },
  ])("returns reset for $name", async ({ prepare }) => {
    const { context, storePath } = await createCursorSession();
    const cursor = await prepare(context, storePath);
    const result = await callChat(context, "chat.history", { cursor });
    expect(result).toMatchObject({ ok: true, payload: { kind: "reset" } });
  });

  test.each(["compaction", "reset"] as const)(
    "resets for an appended %s boundary",
    async (type) => {
      const { context, storePath } = await createCursorSession();
      const page = await callChat<{ deltaCursor?: string }>(context, "chat.history");
      await appendTranscriptEvent(currentScope(storePath), {
        type,
        id: `${type}-boundary`,
        parentId: "cached",
        ...(type === "compaction"
          ? { summary: "summary", firstKeptEntryId: "cached" }
          : { reason: "reset", firstKeptEntryId: "cached" }),
      });
      const result = await callChat(context, "chat.history", { cursor: page.payload?.deltaCursor });
      expect(result).toMatchObject({ ok: true, payload: { kind: "reset" } });
    },
  );

  test("resets when more than 200 raw events are pending", async () => {
    const { context, storePath } = await createCursorSession();
    const page = await callChat<{ deltaCursor?: string }>(context, "chat.history");
    let parentId = "cached";
    for (let index = 0; index < 201; index += 1) {
      const id = `control-${String(index)}`;
      await appendTranscriptEvent(currentScope(storePath), { type: "custom", id, parentId });
      parentId = id;
    }
    const result = await callChat(context, "chat.history", { cursor: page.payload?.deltaCursor });
    expect(result).toMatchObject({ ok: true, payload: { kind: "reset" } });
  });

  test("resets when the pending raw payload exceeds one megabyte", async () => {
    const { context, storePath } = await createCursorSession();
    const page = await callChat<{ deltaCursor?: string }>(context, "chat.history");
    await appendTranscriptEvent(currentScope(storePath), {
      type: "custom",
      id: "oversized",
      parentId: "cached",
      text: "x".repeat(1_000_000),
    });
    const result = await callChat(context, "chat.history", { cursor: page.payload?.deltaCursor });
    expect(result).toMatchObject({ ok: true, payload: { kind: "reset" } });
  });

  test.each(["offset", "messageId"] as const)("rejects cursor with %s", async (field) => {
    const { context } = await createCursorSession();
    const result = await callChat(context, "chat.history", {
      cursor: "cursor",
      [field]: field === "offset" ? 0 : "cached",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("chat.startup returns startup projections with a delta", async () => {
    const { context, storePath } = await createCursorSession();
    context.readChatStartupProjection = async () => ({
      metadata: { swarmEnabled: false },
      sessionModelCatalog: [],
      defaultModelCatalog: [],
    });
    const page = await callChat<{ deltaCursor?: string }>(context, "chat.startup");
    await appendTranscriptMessage(currentScope(storePath), {
      eventId: "startup-append",
      parentId: "cached",
      message: { role: "assistant", content: "startup delta", timestamp: 2 },
    });
    const delta = await callChat<{
      kind?: string;
      messages?: unknown[];
      metadata?: unknown;
      sessionInfo?: unknown;
    }>(context, "chat.startup", { cursor: page.payload?.deltaCursor });
    expect(delta).toMatchObject({
      ok: true,
      payload: {
        kind: "delta",
        messages: [expect.any(Object)],
        sessionInfo: expect.any(Object),
        metadata: expect.any(Object),
      },
    });
    expect(delta.payload).not.toHaveProperty("agentsList");
  });
});
