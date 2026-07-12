// Session history HTTP tests cover transcript-backed history responses,
// operator read auth, exact assistant messages, and transcript update delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, test } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "../config/sessions/transcript.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  emitInternalSessionTranscriptUpdate,
  emitSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../shared/transcript-only-openclaw-assistant.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  writeSessionStore,
} from "./test-helpers.server.js";

installGatewayTestHooks();

const AUTH_HEADER = { Authorization: "Bearer test-gateway-token-1234567890" };
const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };
const cleanupDirs: string[] = [];

afterEach(async () => {
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const AGENT_ID = "main";
type SessionHistoryTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_entries" | "session_routes" | "sessions"
>;

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-history-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {},
    storePath,
  });
  return storePath;
}

async function seedSession(params?: { text?: string }) {
  const storePath = await createSessionStoreFile();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    },
    storePath,
  });
  if (params?.text) {
    const appended = await appendExactAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      storePath,
      message: makeTranscriptAssistantMessage({ text: params.text }),
    });
    expect(appended.ok).toBe(true);
  }
  return { storePath };
}

async function writeResetArchiveTranscript(params: {
  dir: string;
  sessionId: string;
  timestamp: string;
  texts: string[];
}) {
  await fs.writeFile(
    path.join(params.dir, `${params.sessionId}.jsonl.reset.${params.timestamp}`),
    [
      JSON.stringify({ type: "session", version: 1, id: params.sessionId }),
      ...params.texts.map((text) =>
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text }] },
        }),
      ),
    ].join("\n"),
    "utf-8",
  );
}

function seedRawSessionRows(params: {
  storePath: string;
  rows: Array<{ sessionId: string; sessionKey: string; updatedAt: number }>;
}) {
  const databasePath = resolveSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: AGENT_ID,
  }).path;
  if (!databasePath) {
    throw new Error("expected SQLite session store path");
  }
  runOpenClawAgentWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<SessionHistoryTestDatabase>(database.db);
      for (const row of params.rows) {
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("sessions")
            .values({
              session_id: row.sessionId,
              session_key: row.sessionKey,
              created_at: row.updatedAt,
              updated_at: row.updatedAt,
            })
            .onConflict((conflict) =>
              conflict.column("session_id").doUpdateSet({
                session_key: (eb) => eb.ref("excluded.session_key"),
                updated_at: (eb) => eb.ref("excluded.updated_at"),
              }),
            ),
        );
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("session_routes")
            .values({
              session_key: row.sessionKey,
              session_id: row.sessionId,
              updated_at: row.updatedAt,
            })
            .onConflict((conflict) =>
              conflict.column("session_key").doUpdateSet({
                session_id: (eb) => eb.ref("excluded.session_id"),
                updated_at: (eb) => eb.ref("excluded.updated_at"),
              }),
            ),
        );
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("session_entries")
            .values({
              session_id: row.sessionId,
              session_key: row.sessionKey,
              entry_json: JSON.stringify({
                sessionId: row.sessionId,
                updatedAt: row.updatedAt,
              }),
              updated_at: row.updatedAt,
            })
            .onConflict((conflict) =>
              conflict.column("session_key").doUpdateSet({
                session_id: (eb) => eb.ref("excluded.session_id"),
                entry_json: (eb) => eb.ref("excluded.entry_json"),
                updated_at: (eb) => eb.ref("excluded.updated_at"),
              }),
            ),
        );
      }
    },
    { agentId: AGENT_ID, path: databasePath },
  );
}

function makeTranscriptAssistantMessage(params: {
  text: string;
  content?: AssistantMessage["content"];
  provider?: string;
  model?: string;
}): AssistantMessage {
  return {
    role: "assistant" as const,
    content: params.content ?? [{ type: "text", text: params.text }],
    api: "openai-responses",
    provider: params.provider ?? "openai",
    model: params.model ?? "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function makeDeliveryMirrorAssistantMessage(
  params: Parameters<typeof makeTranscriptAssistantMessage>[0],
): AssistantMessage {
  return {
    ...makeTranscriptAssistantMessage({
      ...params,
      provider: "openclaw",
      model: "delivery-mirror",
    }),
    api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  };
}

async function appendTranscriptMessage(params: {
  sessionKey: string;
  message: AssistantMessage;
  emitInlineMessage?: boolean;
  storePath?: string;
}): Promise<string> {
  const appended = await appendExactAssistantMessageToSessionTranscript({
    sessionKey: params.sessionKey,
    storePath: params.storePath ?? testState.sessionStorePath,
    updateMode: params.emitInlineMessage === false ? "file-only" : "inline",
    message: params.message,
  });
  expect(appended.ok).toBe(true);
  if (!appended.ok) {
    throw new Error(`append failed: ${appended.reason}`);
  }
  return appended.messageId;
}

async function appendVisibleAssistantMessage(params: {
  sessionKey: string;
  text: string;
  storePath: string;
}) {
  const appended = await appendExactAssistantMessageToSessionTranscript({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    message: makeTranscriptAssistantMessage({ text: params.text }),
  });
  expect(appended.ok).toBe(true);
  if (!appended.ok) {
    throw new Error(`append failed: ${appended.reason}`);
  }
  return appended.messageId;
}

async function fetchSessionHistory(
  port: number,
  sessionKey: string,
  params?: {
    query?: string;
    headers?: HeadersInit;
  },
) {
  const headers = new Headers();
  for (const [key, value] of new Headers(READ_SCOPE_HEADER).entries()) {
    headers.set(key, value);
  }
  for (const [key, value] of new Headers(params?.headers).entries()) {
    headers.set(key, value);
  }
  return fetch(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionKey)}/history${params?.query ?? ""}`,
    {
      headers,
    },
  );
}

async function withGatewayHarness<T>(
  run: (harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>) => Promise<T>,
) {
  const harness = await createGatewaySuiteHarness({
    serverOptions: {
      auth: { mode: "none" },
    },
  });
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}

type SessionHistoryMessage = {
  content?: Array<{ text?: string }>;
  __openclaw?: { id?: string; seq?: number };
};

type SessionHistoryBody = {
  sessionKey?: string;
  items?: SessionHistoryMessage[];
  messages?: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore?: boolean;
};

async function readSessionHistoryBody(
  port: number,
  sessionKey: string,
  params?: Parameters<typeof fetchSessionHistory>[2],
): Promise<SessionHistoryBody> {
  const res = await fetchSessionHistory(port, sessionKey, params);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionHistoryBody;
}

async function expectSessionHistoryText(params: { sessionKey: string; expectedText: string }) {
  await withGatewayHarness(async (harness) => {
    const body = await readSessionHistoryBody(harness.port, params.sessionKey);
    expect(body.sessionKey).toBe(params.sessionKey);
    expect(body.messages?.[0]?.content?.[0]?.text).toBe(params.expectedText);
  });
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const rawEvent = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const lines = rawEvent.split("\n");
      const event =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!data) {
        continue;
      }
      return { event, data: JSON.parse(data) };
    }
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before next event");
    }
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

type SessionHistorySseStream = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  streamState: { buffer: string };
};

function expectOpenClawMetadata(
  metadata: { id?: string; seq?: number } | undefined,
  expected: { id?: string; seq: number },
) {
  if (expected.id !== undefined) {
    expect(metadata?.id).toBe(expected.id);
  }
  expect(metadata?.seq).toBe(expected.seq);
}

function expectErrorResponse(body: unknown, expected: { type: string; message: string }) {
  expect(body).toEqual({
    ok: false,
    error: {
      type: expected.type,
      message: expected.message,
    },
  });
}

async function openSessionHistorySse(
  port: number,
  sessionKey: string,
  params?: { query?: string },
): Promise<SessionHistorySseStream> {
  const res = await fetchSessionHistory(port, sessionKey, {
    query: params?.query,
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error("expected session-history SSE reader");
  }
  return { reader, streamState: { buffer: "" } };
}

async function withFirstMessageHistoryStream(
  run: (stream: SessionHistorySseStream) => Promise<void>,
) {
  await withGatewayHarness(async (harness) => {
    const stream = await openSessionHistorySse(harness.port, "agent:main:main");
    try {
      await expectHistoryEventTexts(stream, ["first message"]);
      await run(stream);
    } finally {
      await stream.reader.cancel();
    }
  });
}

async function expectHistoryEventTexts(stream: SessionHistorySseStream, expectedTexts: string[]) {
  const event = await readSseEvent(stream.reader, stream.streamState);
  expect(event.event).toBe("history");
  expect(
    (event.data as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages?.map(
      (message) => message.content?.[0]?.text,
    ),
  ).toEqual(expectedTexts);
  return event;
}

async function expectMessageEventMatch(
  stream: SessionHistorySseStream,
  params: { text: string; seq: number; id?: string },
) {
  const event = await readSseEvent(stream.reader, stream.streamState);
  expect(event.event).toBe("message");
  expect(
    (event.data as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]
      ?.text,
  ).toBe(params.text);
  expect((event.data as { messageSeq?: number }).messageSeq).toBe(params.seq);
  if (params.id !== undefined) {
    expectOpenClawMetadata(
      (event.data as { message?: { __openclaw?: { id?: string; seq?: number } } }).message?.[
        "__openclaw"
      ],
      {
        id: params.id,
        seq: params.seq,
      },
    );
  }
  return event;
}

async function openBoundedHistoryStreamWithSecondMessage(
  harnessPort: number,
  storePath: string,
): Promise<SessionHistorySseStream> {
  await appendVisibleAssistantMessage({
    sessionKey: "agent:main:main",
    text: "second message",
    storePath,
  });

  const stream = await openSessionHistorySse(harnessPort, "agent:main:main", {
    query: "?limit=1",
  });
  await expectHistoryEventTexts(stream, ["second message"]);
  return stream;
}

describe("session history HTTP endpoints", () => {
  test("returns session history over direct REST", async () => {
    await seedSession({ text: "hello from history" });
    await withGatewayHarness(async (harness) => {
      const body = await readSessionHistoryBody(harness.port, "agent:main:main");
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages).toHaveLength(1);
      expect(body.messages?.[0]?.content?.[0]?.text).toBe("hello from history");
      expectOpenClawMetadata(body.messages?.[0]?.["__openclaw"], {
        seq: 2,
      });
    });
  });

  test("returns session history from the latest reset archive when the active transcript is missing", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-reset-main";
    const dir = path.dirname(storePath);
    await writeResetArchiveTranscript({
      dir,
      sessionId,
      timestamp: "2026-02-16T22-26-33.000Z",
      texts: ["older archived history"],
    });
    await writeResetArchiveTranscript({
      dir,
      sessionId,
      timestamp: "2026-02-16T22-26-34.000Z",
      texts: ["restored first", "restored latest"],
    });
    await writeSessionStore({
      entries: {
        "agent:main:main": {
          sessionId,
          updatedAt: 1,
        },
      },
      storePath,
    });

    await withGatewayHarness(async (harness) => {
      const body = await readSessionHistoryBody(harness.port, "agent:main:main", {
        query: "?limit=1",
      });
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages?.map((message) => message.content?.[0]?.text)).toEqual([
        "restored latest",
      ]);
      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBe("2");
      expectOpenClawMetadata(body.messages?.[0]?.["__openclaw"], {
        seq: 2,
      });
    });
  });

  test("refreshes unbounded SSE when an active transcript replaces reset archive history", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-reset-sse-takeover";
    const dir = path.dirname(storePath);
    await writeResetArchiveTranscript({
      dir,
      sessionId,
      timestamp: "2026-02-16T22-26-34.000Z",
      texts: ["archived before reset"],
    });
    await writeSessionStore({
      entries: {
        "agent:main:main": {
          sessionId,
          updatedAt: 1,
        },
      },
      storePath,
    });

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      try {
        await expectHistoryEventTexts(stream, ["archived before reset"]);

        const activeMessage = makeTranscriptAssistantMessage({ text: "active after reset" });
        const appended = await appendExactAssistantMessageToSessionTranscript({
          sessionKey: "agent:main:main",
          storePath,
          message: activeMessage,
          updateMode: "none",
        });
        expect(appended.ok).toBe(true);
        if (!appended.ok) {
          throw new Error(`append failed: ${appended.reason}`);
        }
        emitSessionTranscriptUpdate({
          sessionFile: appended.sessionFile,
          sessionKey: "agent:main:main",
          message: activeMessage,
          messageId: appended.messageId,
          messageSeq: 2,
        });

        await expectHistoryEventTexts(stream, ["active after reset"]);
      } finally {
        await stream.reader.cancel();
      }
    });
  });

  test("matches direct REST history paths without trusting malformed Host headers", async () => {
    await seedSession({ text: "history with bad host" });
    await withGatewayHarness(async (harness) => {
      const body = await readSessionHistoryBody(harness.port, "agent:main:main", {
        headers: { Host: "[" },
      });
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages?.[0]?.content?.[0]?.text).toBe("history with bad host");
    });
  });

  test("keeps standalone delivery-mirror rows in direct REST history", async () => {
    const { storePath } = await seedSession({ text: "visible history" });
    await appendTranscriptMessage({
      sessionKey: "agent:main:main",
      storePath,
      message: makeDeliveryMirrorAssistantMessage({ text: "raw delivery mirror" }),
      emitInlineMessage: false,
    });

    await withGatewayHarness(async (harness) => {
      const body = await readSessionHistoryBody(harness.port, "agent:main:main");
      expect(body.messages?.map((message) => message.content?.[0]?.text)).toEqual([
        "visible history",
        "raw delivery mirror",
      ]);
    });
  });

  test("returns 404 for unknown sessions", async () => {
    await createSessionStoreFile();
    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:missing");
      expect(res.status).toBe(404);
      expectErrorResponse(await res.json(), {
        type: "not_found",
        message: "Session not found: agent:main:missing",
      });
    });
  });

  test("prefers the freshest duplicate row for direct history reads", async () => {
    testState.agentsConfig = { list: [{ id: "main", default: true }] };
    testState.sessionConfig = { mainKey: "work" };
    const storePath = await createSessionStoreFile();
    await replaceTranscriptEvents(
      {
        agentId: AGENT_ID,
        sessionId: "sess-stale-main",
        sessionKey: "agent:main:work",
        storePath,
      },
      [
        { type: "session", version: 1, id: "sess-stale-main" },
        {
          message: { role: "assistant", content: [{ type: "text", text: "stale history" }] },
        },
      ],
    );
    await replaceTranscriptEvents(
      {
        agentId: AGENT_ID,
        sessionId: "sess-fresh-main",
        sessionKey: "agent:main:main",
        storePath,
      },
      [
        { type: "session", version: 1, id: "sess-fresh-main" },
        {
          message: { role: "assistant", content: [{ type: "text", text: "fresh history" }] },
        },
      ],
    );
    seedRawSessionRows({
      storePath,
      rows: [
        {
          sessionId: "sess-stale-main",
          sessionKey: "agent:main:work",
          updatedAt: 1,
        },
        {
          sessionId: "sess-fresh-main",
          sessionKey: "agent:main:main",
          updatedAt: 2,
        },
      ],
    });

    await expectSessionHistoryText({
      sessionKey: "agent:main:work",
      expectedText: "fresh history",
    });
  });

  test("supports cursor pagination over direct REST while preserving the messages field", async () => {
    const { storePath } = await seedSession({ text: "first message" });
    await appendVisibleAssistantMessage({
      sessionKey: "agent:main:main",
      text: "second message",
      storePath,
    });
    await appendVisibleAssistantMessage({
      sessionKey: "agent:main:main",
      text: "third message",
      storePath,
    });

    await withGatewayHarness(async (harness) => {
      const firstPage = await fetchSessionHistory(harness.port, "agent:main:main", {
        query: "?limit=2",
      });
      expect(firstPage.status).toBe(200);
      const firstBody = (await firstPage.json()) as SessionHistoryBody;
      expect(firstBody.sessionKey).toBe("agent:main:main");
      expect(firstBody.items?.map((message) => message.content?.[0]?.text)).toEqual([
        "second message",
        "third message",
      ]);
      expect(firstBody.messages?.map((message) => message["__openclaw"]?.seq)).toEqual([3, 4]);
      expect(firstBody.hasMore).toBe(true);
      expect(firstBody.nextCursor).toBe("3");

      const secondPage = await fetchSessionHistory(harness.port, "agent:main:main", {
        query: `?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      });
      expect(secondPage.status).toBe(200);
      const secondBody = (await secondPage.json()) as SessionHistoryBody;
      expect(secondBody.items?.map((message) => message.content?.[0]?.text)).toEqual([
        "first message",
      ]);
      expect(secondBody.messages?.map((message) => message["__openclaw"]?.seq)).toEqual([2]);
      expect(secondBody.hasMore).toBe(false);
      expect(secondBody.nextCursor).toBeUndefined();
    });
  });

  test("caps all-digit direct REST history limits that exceed safe integer range", async () => {
    const { storePath } = await seedSession({ text: "first message" });
    await appendVisibleAssistantMessage({
      sessionKey: "agent:main:main",
      text: "second message",
      storePath,
    });
    await appendVisibleAssistantMessage({
      sessionKey: "agent:main:main",
      text: "third message",
      storePath,
    });

    await withGatewayHarness(async (harness) => {
      const body = await readSessionHistoryBody(harness.port, "agent:main:main", {
        query: `?limit=${"9".repeat(100)}`,
      });

      expect(body.messages?.map((message) => message.content?.[0]?.text)).toEqual([
        "first message",
        "second message",
        "third message",
      ]);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeUndefined();
    });
  });

  test("streams bounded history windows over SSE", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openBoundedHistoryStreamWithSecondMessage(harness.port, storePath);

      const thirdMessageId = await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        storePath,
        emitInlineMessage: false,
        message: makeTranscriptAssistantMessage({ text: "third message" }),
      });

      const nextEvent = await readSseEvent(stream.reader, stream.streamState);
      expect(nextEvent.event).toBe("history");
      const nextData = nextEvent.data as {
        messages?: Array<{
          content?: Array<{ text?: string }>;
          __openclaw?: { id?: string; seq?: number };
        }>;
      };
      expect(nextData.messages?.[0]?.content?.[0]?.text).toBe("third message");
      expectOpenClawMetadata(nextData.messages?.[0]?.["__openclaw"], {
        id: thirdMessageId,
        seq: 4,
      });

      await stream.reader.cancel();
    });
  });

  test("seeds bounded SSE windows from visible history when transcript refreshes are silent", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openBoundedHistoryStreamWithSecondMessage(harness.port, storePath);

      await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        storePath,
        emitInlineMessage: false,
        message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
      });

      const refreshEvent = await readSseEvent(stream.reader, stream.streamState);
      expect(refreshEvent.event).toBe("history");
      const refreshData = refreshEvent.data as {
        messages?: Array<{ content?: Array<{ text?: string }>; __openclaw?: { seq?: number } }>;
      };
      expect(refreshData.messages?.[0]?.content?.[0]?.text).toBe("second message");
      expect(refreshData.messages?.[0]?.["__openclaw"]?.seq).toBe(3);

      await stream.reader.cancel();
    });
  });

  test("sanitizes phased assistant history entries before returning them", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    await withGatewayHarness(async (harness) => {
      const hidden = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "NO_REPLY",
        storePath,
      });
      expect(hidden.ok).toBe(true);

      if (!hidden.ok) {
        throw new Error(`append failed: ${hidden.reason}`);
      }
      const visibleMessageId = await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        storePath,
        message: makeTranscriptAssistantMessage({
          text: "Done.",
          content: [
            {
              type: "text",
              text: "internal reasoning",
              textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Done.",
              textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
            },
          ],
        }),
        emitInlineMessage: false,
      });

      const historyRes = await fetchSessionHistory(harness.port, "agent:main:main");
      expect(historyRes.status).toBe(200);
      const body = (await historyRes.json()) as {
        sessionKey?: string;
        messages?: Array<{
          content?: Array<{ text?: string }>;
          __openclaw?: { id?: string; seq?: number };
        }>;
      };
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages).toHaveLength(1);
      expect(body.messages?.[0]?.content?.[0]?.text).toBe("Done.");
      expectOpenClawMetadata(body.messages?.[0]?.["__openclaw"], {
        id: visibleMessageId,
        seq: 3,
      });
    });
  });

  test("streams session history updates over SSE", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withFirstMessageHistoryStream(async (stream) => {
      const appendedId = await appendVisibleAssistantMessage({
        sessionKey: "agent:main:main",
        text: "second message",
        storePath,
      });
      await expectMessageEventMatch(stream, {
        text: "second message",
        seq: 3,
        id: appendedId,
      });
    });
  });

  test("streams identity-only transcript updates over SSE", async () => {
    await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      await expectHistoryEventTexts(stream, ["first message"]);

      emitInternalSessionTranscriptUpdate({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
        },
        message: makeTranscriptAssistantMessage({ text: "identity second message" }),
        messageId: "msg-identity-second",
        messageSeq: 3,
      });

      await expectMessageEventMatch(stream, {
        text: "identity second message",
        seq: 3,
        id: "msg-identity-second",
      });

      await stream.reader.cancel();
    });
  });

  test("refreshes SSE history for non-monotonic carried sequence", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });
    await replaceTranscriptEvents(
      {
        agentId: AGENT_ID,
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      },
      [
        { type: "session", version: 1, id: "sess-main" },
        {
          id: "msg-first",
          message: makeTranscriptAssistantMessage({ text: "first message" }),
        },
        {
          id: "msg-second",
          message: makeTranscriptAssistantMessage({ text: "second message" }),
        },
      ],
    );

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      await expectHistoryEventTexts(stream, ["first message", "second message"]);

      emitSessionTranscriptUpdate({
        sessionFile: `sqlite:main:sess-main:${storePath}`,
        sessionKey: "agent:main:main",
        message: makeTranscriptAssistantMessage({ text: "rewound branch message" }),
        messageId: "msg-rewound",
        messageSeq: 1,
      });

      await expectHistoryEventTexts(stream, ["first message", "second message"]);

      await stream.reader.cancel();
    });
  });

  test("seeds SSE raw sequence state from startup snapshots, not only visible history", async () => {
    const { storePath } = await seedSession({ text: "first message" });
    await appendTranscriptMessage({
      sessionKey: "agent:main:main",
      storePath,
      message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
      emitInlineMessage: false,
    });

    await withFirstMessageHistoryStream(async (stream) => {
      await appendVisibleAssistantMessage({
        sessionKey: "agent:main:main",
        text: "third visible message",
        storePath,
      });

      await expectMessageEventMatch(stream, {
        text: "third visible message",
        seq: 4,
      });
    });
  });

  test("suppresses NO_REPLY-only SSE fast-path updates while preserving raw sequence numbering", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withFirstMessageHistoryStream(async (stream) => {
      const silent = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "NO_REPLY",
        storePath,
      });
      expect(silent.ok).toBe(true);

      const visibleId = await appendVisibleAssistantMessage({
        sessionKey: "agent:main:main",
        text: "third visible message",
        storePath,
      });
      await expectMessageEventMatch(stream, {
        text: "third visible message",
        seq: 4,
        id: visibleId,
      });
    });
  });

  test("resyncs raw sequence numbering after transcript-only SSE refreshes", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withFirstMessageHistoryStream(async (stream) => {
      await appendVisibleAssistantMessage({
        sessionKey: "agent:main:main",
        text: "second visible message",
        storePath,
      });

      await expectMessageEventMatch(stream, {
        text: "second visible message",
        seq: 3,
      });
      await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        storePath,
        message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
        emitInlineMessage: false,
      });

      await expectHistoryEventTexts(stream, ["first message", "second visible message"]);

      const thirdId = await appendVisibleAssistantMessage({
        sessionKey: "agent:main:main",
        text: "third visible message",
        storePath,
      });
      await expectMessageEventMatch(stream, {
        text: "third visible message",
        seq: 5,
        id: thirdId,
      });
    });
  });

  test("rejects session history when operator.read is not requested", async () => {
    await seedSession({ text: "scope-guarded history" });

    const started = await startServerWithClient("test-gateway-token-1234567890");
    const { server, ws, port: _port, envSnapshot } = started;
    try {
      const connect = await connectReq(ws, {
        token: "test-gateway-token-1234567890",
        scopes: ["operator.approvals"],
      });
      expect(connect.ok).toBe(true);

      const wsHistory = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "agent:main:main",
        limit: 1,
      });
      expect(wsHistory.ok).toBe(false);
      expect(wsHistory.error?.message).toBe("missing scope: operator.read");
    } finally {
      ws.close();
      await server.close();
      envSnapshot.restore();
    }
  });

  test("allows HTTP session history reads with shared-secret bearer auth and default scopes", async () => {
    await seedSession({ text: "bearer allowed history" });

    const started = await startServerWithClient("test-gateway-token-1234567890");
    const { server, ws, port, envSnapshot } = started;
    try {
      const httpHistory = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=1`,
        {
          headers: AUTH_HEADER,
        },
      );
      expect(httpHistory.status).toBe(200);
      const body = await httpHistory.json();
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages?.[0]?.content?.[0]?.text).toBe("bearer allowed history");
    } finally {
      ws.close();
      await server.close();
      envSnapshot.restore();
    }
  });

  test("maintains HTTP SSE streams with shared-secret bearer auth across transcript updates", async () => {
    const { storePath } = await seedSession({ text: "bearer allowed history" });

    const started = await startServerWithClient("test-gateway-token-1234567890");
    const { server, ws, port, envSnapshot } = started;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent("agent:main:main")}/history`,
        {
          headers: {
            ...AUTH_HEADER,
            Accept: "text/event-stream",
          },
        },
      );
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();
      const stream = { reader: reader!, streamState: { buffer: "" } };

      await expectHistoryEventTexts(stream, ["bearer allowed history"]);

      const appendedId = await appendVisibleAssistantMessage({
        sessionKey: "agent:main:main",
        text: "bearer sse update",
        storePath,
      });

      await expectMessageEventMatch(stream, {
        text: "bearer sse update",
        seq: 3,
        id: appendedId,
      });

      await stream.reader.cancel();
    } finally {
      ws.close();
      await server.close();
      envSnapshot.restore();
    }
  });
});
