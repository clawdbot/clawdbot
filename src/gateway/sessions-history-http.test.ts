// Session history HTTP tests cover transcript-backed history responses,
// operator read auth, exact assistant messages, and transcript update delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "../config/sessions/transcript.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.test-support.js";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../shared/transcript-only-openclaw-assistant.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail, setAvatar, setDisplayName } from "../state/user-profiles.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { SSE_CONTENT_TYPE } from "./http-common.js";
import { hasExplicitAcceptableMediaRange } from "./http-media-range.js";
import { SessionHistorySseState } from "./session-history-state.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  writeSessionStore,
} from "./test-helpers.server.js";

const AUTH_HEADER = { Authorization: "Bearer test-gateway-token-1234567890" };
const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };
const cleanupDirs: string[] = [];
const requireRecord = createRequireRecord("object", "expected-label");

const AGENT_ID = "main";
type SessionHistoryTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_nodes" | "session_windows"
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
            .insertInto("session_nodes")
            .values({
              current_session_id: row.sessionId,
              entry_json: JSON.stringify({
                sessionId: row.sessionId,
                updatedAt: row.updatedAt,
              }),
              session_key: row.sessionKey,
              updated_at: row.updatedAt,
            })
            .onConflict((conflict) =>
              conflict.column("session_key").doUpdateSet({
                current_session_id: (eb) => eb.ref("excluded.current_session_id"),
                entry_json: (eb) => eb.ref("excluded.entry_json"),
                updated_at: (eb) => eb.ref("excluded.updated_at"),
              }),
            ),
        );
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("session_windows")
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
  return await appendTranscriptMessage({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    message: makeTranscriptAssistantMessage({ text: params.text }),
  });
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
  __openclaw?: { id?: string; seq?: number; turnBoundary?: boolean };
};

type SessionHistoryBody = {
  sessionKey?: string;
  items?: SessionHistoryMessage[];
  messages?: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore?: boolean;
};

function sessionHistoryRowIdentity(message: unknown): string {
  const record = requireRecord(message, "session history row");
  const metadata = requireRecord(record["__openclaw"], "session history row metadata");
  const firstContent = Array.isArray(record.content)
    ? requireRecord(record.content[0], "session history row content")
    : undefined;
  const label =
    (typeof firstContent?.text === "string" ? firstContent.text : undefined) ??
    (typeof firstContent?.id === "string" ? firstContent.id : undefined) ??
    (typeof record.toolCallId === "string" ? record.toolCallId : "");
  const kind = record.openclawMessageToolMirror ? "mirror" : String(record.role);
  return `${String(metadata.seq)}:${kind}:${label}`;
}

async function readSessionHistoryBody(
  port: number,
  sessionKey: string,
  params?: Parameters<typeof fetchSessionHistory>[2],
): Promise<SessionHistoryBody> {
  const res = await fetchSessionHistory(port, sessionKey, params);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionHistoryBody;
}

function attributedHistoryMessageProjection(value: unknown) {
  const message = requireRecord(value, "attributed history message");
  const metadata = requireRecord(message["__openclaw"], "attributed history metadata");
  return {
    role: message.role,
    content: message.content,
    __openclaw: {
      id: metadata.id,
      seq: metadata.seq,
      senderId: metadata.senderId,
      senderName: metadata.senderName,
      senderUsername: metadata.senderUsername,
      senderProfileAvatarUrl: metadata.senderProfileAvatarUrl,
    },
  };
}

function withMockedDateNow<T>(now: number, run: () => T): T {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    return run();
  } finally {
    clock.mockRestore();
  }
}

function currentProfileAvatarUrl(profileId: string): string {
  const display = resolveCurrentUserProfileDisplay(profileId);
  expect(display.kind).toBe("resolved");
  if (display.kind !== "resolved") {
    throw new Error("expected a resolved current profile display");
  }
  return display.avatarUrl;
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

describe("session history Accept parsing", () => {
  test.each([
    { accept: undefined, expected: false, name: "missing field" },
    { accept: "", expected: false, name: "empty field" },
    { accept: "application/json", expected: false, name: "JSON only" },
    { accept: "text/event-stream", expected: true, name: "exact media type" },
    { accept: "TEXT/EVENT-STREAM", expected: true, name: "case-insensitive media type" },
    { accept: "  text/event-stream  ", expected: true, name: "optional whitespace" },
    { accept: "text/event-stream;", expected: true, name: "omitted trailing parameter" },
    {
      accept: "text/event-stream; ; q=0.5;",
      expected: true,
      name: "omitted parameter slots",
    },
    {
      accept: "text/event-stream; charset=utf-8",
      expected: true,
      name: "media parameter",
    },
    {
      accept: 'text/event-stream; note="quoted,comma;semicolon\\\"quote"; q=0.5',
      expected: false,
      name: "quoted and escaped unmatched parameter delimiters",
    },
    {
      accept: 'text/event-stream; profile="quoted,comma;semicolon\\\"quote"; q=0.5',
      expected: true,
      name: "quoted and escaped matching parameter delimiters",
      representation: 'text/event-stream; profile="quoted,comma;semicolon\\\"quote"',
    },
    {
      accept: 'text/event-stream; profile="https://example.test/profile"',
      expected: false,
      name: "case-sensitive parameter mismatch",
      representation: 'text/event-stream; profile="https://example.test/Profile"',
    },
    {
      accept: "text/event-stream; charset=UTF-8",
      expected: true,
      name: "case-insensitive charset parameter",
    },
    { accept: "text/event-stream;q=0.001", expected: true, name: "minimum positive qvalue" },
    { accept: "text/event-stream;Q=1.000", expected: true, name: "maximum qvalue" },
    {
      accept: "application/json, text/event-stream;q=0.5",
      expected: true,
      name: "explicit media range in a list",
    },
    {
      accept: "text/event-stream;q=0, text/event-stream;q=0.5",
      expected: true,
      name: "duplicate exact ranges with a positive quality",
    },
    {
      accept: "text/event-stream;q=1, text/event-stream;charset=utf-8;q=0",
      expected: false,
      name: "more-specific matching parameter rejection",
    },
    {
      accept: "text/event-stream;q=0, text/event-stream;charset=utf-8;q=0.5",
      expected: true,
      name: "more-specific matching parameter acceptance",
    },
    {
      accept: "text/event-stream;q=0.5;charset=utf-8",
      expected: true,
      name: "matching media parameter after q",
    },
    {
      accept: "text/event-stream;q=1;charset=utf-16",
      expected: false,
      name: "mismatched media parameter after q",
    },
    {
      accept: "text/event-stream; charset=utf-16",
      expected: false,
      name: "mismatched representation parameter",
    },
    { accept: "text/event-streaming", expected: false, name: "lookalike subtype" },
    { accept: "text/event-streamx", expected: false, name: "suffixed subtype" },
    {
      accept: 'application/json; note="text/event-stream"',
      expected: false,
      name: "quoted parameter decoy",
    },
    { accept: "text/*", expected: false, name: "type wildcard" },
    { accept: "*/*", expected: false, name: "all wildcard" },
    { accept: "text/event-stream;q=0", expected: false, name: "zero qvalue" },
    { accept: "text/event-stream;q=0.000", expected: false, name: "zero decimal qvalue" },
    {
      accept: "text/event-stream;q=0, */*;q=1",
      expected: false,
      name: "explicit rejection overriding wildcard",
    },
    { accept: "text/event-stream;q=.5", expected: false, name: "missing leading zero" },
    { accept: "text/event-stream;q =0.5", expected: false, name: "whitespace before equals" },
    { accept: "text/event-stream;q= 0.5", expected: false, name: "whitespace after equals" },
    {
      accept: "text/event-stream;\u00a0q=0.5",
      expected: false,
      name: "non-HTTP parameter whitespace",
    },
    { accept: "text/event-stream;q=0.1234", expected: false, name: "too many q digits" },
    { accept: "text/event-stream;q=1.001", expected: false, name: "qvalue above one" },
    { accept: "text/event-stream;q=1e0", expected: false, name: "exponent qvalue" },
    { accept: 'text/event-stream;q="0.5"', expected: false, name: "quoted qvalue" },
    { accept: "text/event-stream;q=0.5;q=1", expected: false, name: "duplicate q parameter" },
    {
      accept: 'text/event-stream;q=0.5;legacy;note="quoted,comma;semicolon"',
      expected: false,
      name: "obsolete bare Accept extension after q",
    },
    {
      accept: 'text/event-stream; note="unterminated',
      expected: false,
      name: "unterminated quoted parameter",
    },
  ])("returns $expected for $name", ({ accept, expected, representation }) => {
    expect(hasExplicitAcceptableMediaRange(accept, representation ?? SSE_CONTENT_TYPE)).toBe(
      expected,
    );
  });
});

describe("session history HTTP endpoints", () => {
  installGatewayTestHooks();

  afterEach(async () => {
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
    await Promise.all(
      cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  test("uses SSE only for an explicit acceptable event-stream media range", async () => {
    const expectedText = "accept negotiation sentinel";
    await seedSession({ text: expectedText });
    await withGatewayHarness(async (harness) => {
      const cases = [
        { accept: "text/event-stream", expected: "sse" },
        { accept: "TEXT/EVENT-STREAM", expected: "sse" },
        { accept: "  text/event-stream  ", expected: "sse" },
        { accept: "text/event-stream;", expected: "sse" },
        { accept: "text/event-stream; ; q=0.5;", expected: "sse" },
        { accept: "text/event-stream; charset=utf-8", expected: "sse" },
        {
          accept: 'text/event-stream; note="quoted,comma;semicolon\\\"quote"; q=0.5',
          expected: "json",
        },
        { accept: "text/event-stream;q=0.001", expected: "sse" },
        { accept: "text/event-stream;Q=1.000", expected: "sse" },
        { accept: "text/event-stream;q=0, text/event-stream;q=0.5", expected: "sse" },
        {
          accept: "text/event-stream;q=1, text/event-stream;charset=utf-8;q=0",
          expected: "json",
        },
        {
          accept: "text/event-stream;q=0, text/event-stream;charset=utf-8;q=0.5",
          expected: "sse",
        },
        { accept: "text/event-stream;q=0.5;charset=utf-8", expected: "sse" },
        { accept: "text/event-stream;q=1;charset=utf-16", expected: "json" },
        { accept: "text/event-stream;charset=utf-16", expected: "json" },
        { accept: "text/event-streaming", expected: "json" },
        { accept: "text/event-streamx", expected: "json" },
        { accept: 'application/json; note="text/event-stream"', expected: "json" },
        { accept: "text/*", expected: "json" },
        { accept: "*/*", expected: "json" },
        { accept: "text/event-stream;q=0", expected: "json" },
        { accept: "text/event-stream;q=0, */*;q=1", expected: "json" },
        { accept: "text/event-stream;q=0.1234", expected: "json" },
        { accept: "text/event-stream;q =0.5", expected: "json" },
        { accept: "text/event-stream;q= 0.5", expected: "json" },
        { accept: "text/event-stream;\u00a0q=0.5", expected: "json" },
        {
          accept: 'text/event-stream;q=0.5;legacy;note="quoted,comma;semicolon"',
          expected: "json",
        },
      ] as const;

      for (const testCase of cases) {
        const response = await fetchSessionHistory(harness.port, "agent:main:main", {
          headers: { Accept: testCase.accept },
        });
        expect(response.status, testCase.accept).toBe(200);
        const contentType = response.headers.get("content-type") ?? "";
        if (testCase.expected === "sse") {
          expect(contentType, testCase.accept).toContain("text/event-stream");
          const reader = response.body?.getReader();
          expect(reader, testCase.accept).toBeDefined();
          const event = await readSseEvent(reader!, { buffer: "" });
          expect(event.event, testCase.accept).toBe("history");
          expect(
            (event.data as SessionHistoryBody).messages?.[0]?.content?.[0]?.text,
            testCase.accept,
          ).toBe(expectedText);
          await reader!.cancel();
          continue;
        }
        expect(contentType, testCase.accept).toContain("application/json");
        const body = (await response.json()) as SessionHistoryBody;
        expect(body.messages?.[0]?.content?.[0]?.text, testCase.accept).toBe(expectedText);
      }
    });
  });

  test.each(["", "?cursor=", "?cursor=%20"])("returns history for query %j", async (query) => {
    await seedSession({ text: "hello from history" });
    await withGatewayHarness(async (harness) => {
      const body = await readSessionHistoryBody(harness.port, "agent:main:main", { query });
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages).toHaveLength(1);
      expect(body.messages?.[0]?.content?.[0]?.text).toBe("hello from history");
      expectOpenClawMetadata(body.messages?.[0]?.["__openclaw"], {
        seq: 1,
      });
    });
  });

  test("shares revisioned current-profile projection across REST and initial and inline SSE", async () => {
    const OLD_REV = 1_800_000_000_000;
    const NEW_REV = 1_900_000_000_000;
    const { storePath } = await seedSession();
    const sessionId = "sess-main";
    const sessionKey = "agent:main:main";
    const sessionEntry = { sessionId, updatedAt: 1 };

    const profile = withMockedDateNow(OLD_REV, () => {
      const created = ensureProfileForEmail("session-history-profile@example.com");
      setDisplayName(created.id, "Old Display Name");
      expect(setAvatar(created.id, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
      return created;
    });
    const oldAvatarUrl = currentProfileAvatarUrl(profile.id);
    const persistAttributedTurn = async (id: string, senderName: string, text: string) => {
      const turn = await persistUserTurnTranscript({
        agentId: AGENT_ID,
        sessionEntry,
        sessionId,
        sessionKey,
        storePath,
        input: {
          idempotencyKey: `session-history-profile:${id}`,
          sender: { id: profile.id, name: senderName, username: "ada" },
          text,
        },
      });
      expect(turn).toBeDefined();
      return turn!;
    };
    const first = await persistAttributedTurn(
      "first",
      "Historical Ada",
      "first attributed history turn",
    );

    await withGatewayHarness(async (harness) => {
      const initialRest = await readSessionHistoryBody(harness.port, sessionKey);
      const stream = await openSessionHistorySse(harness.port, sessionKey);
      try {
        const initialSse = await readSseEvent(stream.reader, stream.streamState);
        expect(initialSse.event).toBe("history");
        const oldExpected = {
          role: "user",
          content: "first attributed history turn",
          __openclaw: {
            id: first.messageId,
            seq: 1,
            senderId: profile.id,
            senderName: "Historical Ada",
            senderUsername: "ada",
            senderProfileAvatarUrl: oldAvatarUrl,
          },
        };
        expect(attributedHistoryMessageProjection(initialRest.messages?.[0])).toEqual(oldExpected);
        expect(
          attributedHistoryMessageProjection((initialSse.data as SessionHistoryBody).messages?.[0]),
        ).toEqual(oldExpected);

        withMockedDateNow(NEW_REV, () => {
          setDisplayName(profile.id, "Current Ada");
          expect(setAvatar(profile.id, new Uint8Array([4, 5, 6]), "image/png").ok).toBe(true);
        });
        const newAvatarUrl = currentProfileAvatarUrl(profile.id);
        expect(newAvatarUrl).not.toBe(oldAvatarUrl);

        const inlineEventPromise = readSseEvent(stream.reader, stream.streamState);
        const second = await persistAttributedTurn(
          "second",
          "Current Ada",
          "second attributed history turn",
        );
        const refreshEvent = await inlineEventPromise;
        expect(refreshEvent.event).toBe("history");
        const newSecondExpected = {
          role: "user",
          content: "second attributed history turn",
          __openclaw: {
            id: second.messageId,
            seq: 2,
            senderId: profile.id,
            senderName: "Current Ada",
            senderUsername: "ada",
            senderProfileAvatarUrl: newAvatarUrl,
          },
        };
        const newFirstExpected = {
          ...oldExpected,
          __openclaw: {
            ...oldExpected["__openclaw"],
            senderProfileAvatarUrl: newAvatarUrl,
          },
        };
        const refreshedSse = refreshEvent.data as SessionHistoryBody;
        expect(refreshedSse.messages).toHaveLength(2);
        expect(attributedHistoryMessageProjection(refreshedSse.messages?.[0])).toEqual(
          newFirstExpected,
        );
        expect(attributedHistoryMessageProjection(refreshedSse.messages?.[1])).toEqual(
          newSecondExpected,
        );

        const refreshedRest = await readSessionHistoryBody(harness.port, sessionKey);
        expect(refreshedRest.messages).toHaveLength(2);
        expect(attributedHistoryMessageProjection(refreshedRest.messages?.[0])).toEqual(
          newFirstExpected,
        );
        expect(attributedHistoryMessageProjection(refreshedRest.messages?.[1])).toEqual(
          newSecondExpected,
        );
      } finally {
        await stream.reader.cancel();
      }
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

      const older = await readSessionHistoryBody(harness.port, "agent:main:main", {
        query: `?limit=1&cursor=${body.nextCursor}`,
      });
      expect(older.messages?.map((message) => message.content?.[0]?.text)).toEqual([
        "restored first",
      ]);
      expect(older.hasMore).toBe(false);
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
          sessionFile: appended.target.sessionKey,
          sessionKey: "agent:main:main",
          target: {
            agentId: appended.target.agentId ?? "main",
            sessionId: appended.target.sessionId,
            sessionKey: appended.target.sessionKey,
          },
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

  test("claims invalid encoded session keys on a listening Gateway", async () => {
    await withGatewayHarness(async (harness) => {
      for (const encodedSessionKey of ["%20", "%zz"]) {
        const response = await fetch(
          `http://127.0.0.1:${harness.port}/sessions/${encodedSessionKey}/history`,
        );
        const body = await response.json();
        expect(response.status).toBe(400);
        expect(body).toEqual({
          error: {
            type: "invalid_request_error",
            message: "invalid session key",
          },
        });
      }
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

  test("rejects duplicate canonical rows with an actionable migration error", async () => {
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

    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:work");
      expect(res.status).toBe(409);
      expectErrorResponse(await res.json(), {
        type: "migration_required",
        message:
          "duplicate rows resolve to canonical session key agent:main:work; stop the Gateway and run openclaw doctor --fix",
      });
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
      expect(firstBody.messages?.map((message) => message["__openclaw"]?.seq)).toEqual([2, 3]);
      expect(firstBody.hasMore).toBe(true);
      expect(firstBody.nextCursor).toBe("2");

      const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: AGENT_ID,
      }).path;
      if (!databasePath) {
        throw new Error("expected session database path");
      }
      runOpenClawAgentWriteTransaction(
        (database) => {
          const db = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "transcript_events">>(
            database.db,
          );
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("transcript_events")
              .set({ event_json: "{" })
              .where("session_id", "=", "sess-main")
              .where("event_json", "like", "%third message%"),
          );
        },
        { agentId: AGENT_ID, path: databasePath },
      );

      const secondPage = await fetchSessionHistory(harness.port, "agent:main:main", {
        query: `?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      });
      expect(secondPage.status).toBe(200);
      const secondBody = (await secondPage.json()) as SessionHistoryBody;
      expect(secondBody.items?.map((message) => message.content?.[0]?.text)).toEqual([
        "first message",
      ]);
      expect(secondBody.messages?.map((message) => message["__openclaw"]?.seq)).toEqual([1]);
      expect(secondBody.hasMore).toBe(false);
      expect(secondBody.nextCursor).toBeUndefined();
    });
  });

  test("keeps same-sequence SQLite projection rows reachable over REST and SSE", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-same-sequence";
    const sessionKey = "agent:main:main";
    const sharedTimestamp = Date.UTC(2026, 7, 15, 9, 30, 0);
    await writeSessionStore({
      entries: { main: { sessionId, updatedAt: sharedTimestamp } },
      storePath,
    });
    await replaceTranscriptEvents({ agentId: AGENT_ID, sessionId, sessionKey, storePath }, [
      { type: "session", version: 1, id: sessionId },
      {
        id: "history-user",
        message: {
          role: "user",
          content: [{ type: "text", text: "reply here" }],
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-tool-call",
        message: {
          ...makeTranscriptAssistantMessage({ text: "" }),
          content: [
            {
              type: "toolCall",
              id: "call-message-first",
              name: "message",
              arguments: { action: "send", message: "First visible reply." },
            },
            {
              type: "toolCall",
              id: "call-message-second",
              name: "message",
              arguments: { action: "send", message: "Second visible reply." },
            },
          ],
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-tool-result-first",
        message: {
          role: "toolResult",
          toolName: "message",
          toolCallId: "call-message-first",
          content: { ok: true, messageId: "same-sequence-first" },
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-tool-result-second",
        message: {
          role: "toolResult",
          toolName: "message",
          toolCallId: "call-message-second",
          content: { ok: true, messageId: "same-sequence-second" },
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-hidden-control",
        message: {
          ...makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
          timestamp: sharedTimestamp,
        },
      },
    ]);

    await withGatewayHarness(async (harness) => {
      const firstPage = await readSessionHistoryBody(harness.port, sessionKey, {
        query: "?limit=1",
      });
      expect(firstPage.messages?.map(sessionHistoryRowIdentity)).toEqual([
        "3:toolResult:call-message-first",
        "4:toolResult:call-message-second",
        "3:mirror:First visible reply.",
        "4:mirror:Second visible reply.",
      ]);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).toBe("3");

      const stream = await openSessionHistorySse(harness.port, sessionKey, {
        query: "?limit=1",
      });
      try {
        const event = await readSseEvent(stream.reader, stream.streamState);
        expect(event.event).toBe("history");
        const data = event.data as SessionHistoryBody;
        expect(data.messages?.map(sessionHistoryRowIdentity)).toEqual(
          firstPage.messages?.map(sessionHistoryRowIdentity),
        );
        expect(data).toMatchObject({ hasMore: true, nextCursor: "3" });
      } finally {
        await stream.reader.cancel();
      }

      const pages: SessionHistoryBody[] = [firstPage];
      const seenCursors = new Set<string>();
      let cursor = firstPage.nextCursor;
      while (cursor) {
        expect(seenCursors.has(cursor)).toBe(false);
        seenCursors.add(cursor);
        const page = await readSessionHistoryBody(harness.port, sessionKey, {
          query: `?limit=1&cursor=${encodeURIComponent(cursor)}`,
        });
        pages.push(page);
        cursor = page.hasMore ? page.nextCursor : undefined;
      }

      const chronologicalRows = pages.toReversed().flatMap((page) => page.messages ?? []);
      expect(chronologicalRows.map(sessionHistoryRowIdentity)).toEqual([
        "1:user:reply here",
        "2:assistant:call-message-first",
        "3:toolResult:call-message-first",
        "4:toolResult:call-message-second",
        "3:mirror:First visible reply.",
        "4:mirror:Second visible reply.",
      ]);
      expect(
        chronologicalRows.map((message) => requireRecord(message, "history timestamp").timestamp),
      ).toEqual(Array.from({ length: 6 }, () => sharedTimestamp));
      expect(
        pages
          .flatMap((page) => page.messages ?? [])
          .some((message) => sessionHistoryRowIdentity(message).includes("NO_REPLY")),
      ).toBe(false);
      expect(seenCursors).toEqual(new Set(["3", "2"]));
      expect(pages.at(-1)).toMatchObject({ hasMore: false });
      expect(pages.at(-1)?.nextCursor).toBeUndefined();
    });
  });

  test("keeps repeated assistant replies from separate hidden user turns in REST and SSE history", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-hidden-turn-replies";
    const sessionKey = "agent:main:main";
    await writeSessionStore({
      entries: { main: { sessionId, updatedAt: Date.now() } },
      storePath,
    });
    const assistantMessage = (text: string, model: string) =>
      makeTranscriptAssistantMessage({ text, provider: "openclaw", model });
    await replaceTranscriptEvents({ agentId: AGENT_ID, sessionId, sessionKey, storePath }, [
      { type: "session", version: 1, id: sessionId },
      { message: assistantMessage("First reply.", "acp-runtime") },
      { message: { role: "user", content: "" } },
      { message: assistantMessage("First reply.", "gateway-injected") },
      { message: assistantMessage("Second reply.", "acp-runtime") },
      { message: { role: "user", content: HEARTBEAT_PROMPT } },
      { message: assistantMessage("Second reply.", "gateway-injected") },
      { message: assistantMessage("Third reply.", "acp-runtime") },
      { message: { role: "user", content: HEARTBEAT_PROMPT } },
      { message: { role: "assistant", content: "HEARTBEAT_OK" } },
      { message: assistantMessage("Third reply.", "gateway-injected") },
    ]);

    const expectedRows = [
      "1:assistant:First reply.",
      "3:assistant:First reply.",
      "4:assistant:Second reply.",
      "6:assistant:Second reply.",
      "7:assistant:Third reply.",
      "10:assistant:Third reply.",
    ];
    await withGatewayHarness(async (harness) => {
      const history = await readSessionHistoryBody(harness.port, sessionKey);
      expect(history.messages?.map(sessionHistoryRowIdentity)).toEqual(expectedRows);
      expect(history.messages?.map((message) => message["__openclaw"]?.turnBoundary)).toEqual([
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        true,
      ]);

      const stream = await openSessionHistorySse(harness.port, sessionKey);
      try {
        const event = await readSseEvent(stream.reader, stream.streamState);
        expect(event.event).toBe("history");
        const streamedHistory = event.data as SessionHistoryBody;
        expect(streamedHistory.messages?.map(sessionHistoryRowIdentity)).toEqual(expectedRows);
      } finally {
        await stream.reader.cancel();
      }
    });
  });

  test.each([
    { name: "all-silent tail", heartbeatBoundary: false, silentMessages: 40 },
    { name: "heartbeat context boundary", heartbeatBoundary: true, silentMessages: 39 },
  ])(
    "backfills REST and SSE history past an all-silent bounded tail ($name)",
    async ({ heartbeatBoundary, silentMessages }) => {
      const storePath = await createSessionStoreFile();
      const sessionId = "sess-silent-tail";
      const sessionKey = "agent:main:main";
      await writeSessionStore({
        entries: { main: { sessionId, updatedAt: Date.now() } },
        storePath,
      });
      await replaceTranscriptEvents({ agentId: AGENT_ID, sessionId, sessionKey, storePath }, [
        { type: "session", version: 1, id: sessionId },
        ...(heartbeatBoundary ? [{ message: { role: "user", content: HEARTBEAT_PROMPT } }] : []),
        { message: { role: "assistant", content: "reachable older history" } },
        ...Array.from({ length: silentMessages }, () => ({
          message: { role: "assistant", content: "NO_REPLY" },
        })),
      ]);

      await withGatewayHarness(async (harness) => {
        const firstPage = await readSessionHistoryBody(harness.port, sessionKey, {
          query: "?limit=1",
        });
        expect(firstPage.messages?.map((message) => message.content)).toEqual([
          "reachable older history",
        ]);
        expect(firstPage.hasMore).toBe(heartbeatBoundary);
        expect(firstPage.nextCursor).toBe(heartbeatBoundary ? "2" : undefined);
        expect(firstPage.messages?.[0]?.["__openclaw"]?.turnBoundary === true).toBe(
          heartbeatBoundary,
        );

        const stream = await openSessionHistorySse(harness.port, sessionKey, {
          query: "?limit=1",
        });
        try {
          const event = await readSseEvent(stream.reader, stream.streamState);
          expect(event.event).toBe("history");
          const history = event.data as SessionHistoryBody;
          expect(history.messages?.map((message) => message.content)).toEqual([
            "reachable older history",
          ]);
          expect(history.hasMore).toBe(heartbeatBoundary);
          expect(history.nextCursor).toBe(heartbeatBoundary ? "2" : undefined);
          expect(history.messages?.[0]?.["__openclaw"]?.turnBoundary === true).toBe(
            heartbeatBoundary,
          );
        } finally {
          await stream.reader.cancel();
        }

        if (!heartbeatBoundary) {
          await replaceTranscriptEvents({ agentId: AGENT_ID, sessionId, sessionKey, storePath }, [
            { type: "session", version: 1, id: sessionId },
            { message: { role: "assistant", content: "older visible history" } },
            ...Array.from({ length: 60 }, () => ({
              message: { role: "assistant", content: "NO_REPLY" },
            })),
            { message: { role: "assistant", content: "newer visible history" } },
          ]);

          const sparsePage = await readSessionHistoryBody(harness.port, sessionKey, {
            query: "?limit=2",
          });
          expect(sparsePage.messages?.map((message) => message.content)).toEqual([
            "older visible history",
            "newer visible history",
          ]);
        }
      });
    },
  );

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

  test.each(["", " ", "abc", "0", "-5", "1.5"])(
    "rejects invalid limit %j with 400",
    async (limit) => {
      await seedSession({ text: "first message" });
      await withGatewayHarness(async (harness) => {
        const res = await fetchSessionHistory(harness.port, "agent:main:main", {
          query: `?limit=${encodeURIComponent(limit)}`,
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error?.type).toBe("invalid_request_error");
        expect(body.error?.message).toBe("limit must be a positive integer");
      });
    },
  );

  test.each(["garbage", "seq:garbage", "seq:0", "seq:99999999999999999999", "0", "-1", "1.5"])(
    "rejects invalid cursor %j with 400",
    async (cursor) => {
      await seedSession({ text: "first message" });
      await withGatewayHarness(async (harness) => {
        const res = await fetchSessionHistory(harness.port, "agent:main:main", {
          query: `?cursor=${encodeURIComponent(cursor)}`,
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error?.type).toBe("invalid_request_error");
        expect(body.error?.message).toBe("cursor must be a positive integer");
      });
    },
  );

  test.each(["1", "+1"])(
    "returns the requested bounded history for valid limit %s",
    async (limit) => {
      const { storePath } = await seedSession({ text: "first message" });
      await appendVisibleAssistantMessage({
        sessionKey: "agent:main:main",
        text: "second message",
        storePath,
      });

      await withGatewayHarness(async (harness) => {
        const body = await readSessionHistoryBody(harness.port, "agent:main:main", {
          query: `?limit=${encodeURIComponent(limit)}`,
        });
        expect(body.messages?.map((message) => message.content?.[0]?.text)).toEqual([
          "second message",
        ]);
        expect(body.hasMore).toBe(true);
      });
    },
  );

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
        seq: 3,
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
      expect(refreshData.messages?.[0]?.["__openclaw"]?.seq).toBe(2);

      await stream.reader.cancel();
    });
  });

  test.each(["text", "output_text", "input_text"])(
    "sanitizes phased %s assistant history entries before returning them",
    async (blockType) => {
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
        const visibleMessageId = "visible-phased-assistant";
        await replaceTranscriptEvents(
          { agentId: AGENT_ID, sessionId: "sess-main", sessionKey: "agent:main:main", storePath },
          [
            { type: "session", version: 1, id: "sess-main" },
            { id: "hidden-control", message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }) },
            {
              id: visibleMessageId,
              message: {
                ...makeTranscriptAssistantMessage({ text: "Done." }),
                content: [
                  {
                    type: blockType,
                    text: "internal reasoning",
                    textSignature: JSON.stringify({
                      v: 1,
                      id: "item_commentary",
                      phase: "commentary",
                    }),
                  },
                  {
                    type: blockType,
                    text: "Done.",
                    textSignature: JSON.stringify({
                      v: 1,
                      id: "item_final",
                      phase: "final_answer",
                    }),
                  },
                ],
              },
            },
          ],
        );

        const historyRes = await fetchSessionHistory(harness.port, "agent:main:main");
        expect(historyRes.status).toBe(200);
        const body = (await historyRes.json()) as {
          sessionKey?: string;
          messages?: Array<{
            content?: Array<{ text?: string }>;
            openclawStreamFallback?: { itemId?: string; replacementText?: string; source?: string };
            __openclaw?: { id?: string; seq?: number };
          }>;
        };
        expect(body.sessionKey).toBe("agent:main:main");
        expect(body.messages).toHaveLength(2);
        expect(body.messages?.[0]).toMatchObject({
          content: [{ type: "text", text: "internal reasoning" }],
          openclawStreamFallback: {
            itemId: "item_commentary",
            replacementText: "internal reasoning",
            source: "segment",
          },
        });
        expect(body.messages?.[1]?.content?.map((block) => block.text)).toEqual(["Done."]);
        expectOpenClawMetadata(body.messages?.[1]?.["__openclaw"], {
          id: visibleMessageId,
          seq: 2,
        });
      });
    },
  );

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
        seq: 2,
        id: appendedId,
      });
    });
  });

  test("bounds retained SSE history without truncating full history or live updates", async () => {
    const retainedMessageLimit = 1_000;
    const initialMessageCount = retainedMessageLimit + 2;
    const sessionKey = "agent:main:main";
    const { storePath } = await seedSession();
    await replaceTranscriptEvents(
      {
        agentId: AGENT_ID,
        sessionId: "sess-main",
        sessionKey,
        storePath,
      },
      [
        { type: "session", version: 1, id: "sess-main" },
        ...Array.from({ length: initialMessageCount }, (_, index) => ({
          id: `history-message-${index + 1}`,
          parentId: index === 0 ? null : `history-message-${index}`,
          message: makeTranscriptAssistantMessage({ text: `history message ${index + 1}` }),
        })),
      ],
    );

    const snapshotSpy = vi.spyOn(SessionHistorySseState.prototype, "snapshot");
    try {
      await withGatewayHarness(async (harness) => {
        const stream = await openSessionHistorySse(harness.port, sessionKey);
        try {
          const initialEvent = await readSseEvent(stream.reader, stream.streamState);
          expect(initialEvent.event).toBe("history");
          const initialMessages = (initialEvent.data as SessionHistoryBody).messages ?? [];
          expect(initialMessages).toHaveLength(initialMessageCount);
          expect(initialMessages[0]?.content?.[0]?.text).toBe("history message 1");

          const retained = snapshotSpy.mock.results.at(-1)?.value as
            | { messages?: SessionHistoryMessage[] }
            | undefined;
          expect(retained?.messages).toHaveLength(retainedMessageLimit);
          expect(retained?.messages?.[0]?.content?.[0]?.text).toBe("history message 3");

          const cursorStream = await openSessionHistorySse(harness.port, sessionKey, {
            query: `?cursor=${initialMessageCount + 1}`,
          });
          try {
            const cursorEvent = await readSseEvent(cursorStream.reader, cursorStream.streamState);
            expect(cursorEvent.event).toBe("history");
            expect((cursorEvent.data as SessionHistoryBody).messages).toHaveLength(
              initialMessageCount,
            );
            const cursorSnapshot = snapshotSpy.mock.results.at(-1)?.value as
              | { messages?: SessionHistoryMessage[] }
              | undefined;
            expect(cursorSnapshot?.messages).toHaveLength(retainedMessageLimit);
            expect(cursorSnapshot?.messages?.[0]?.content?.[0]?.text).toBe("history message 3");

            const messageId = await appendVisibleAssistantMessage({
              sessionKey,
              text: "live history message",
              storePath,
            });
            const lastSequence = initialMessages.at(-1)?.["__openclaw"]?.seq;
            expect(lastSequence).toEqual(expect.any(Number));
            await expectMessageEventMatch(stream, {
              text: "live history message",
              seq: (lastSequence ?? 0) + 1,
              id: messageId,
            });

            const liveRetained = snapshotSpy.mock.results.findLast((result) => {
              const snapshot = result.value as { messages?: SessionHistoryMessage[] } | undefined;
              return snapshot?.messages?.at(-1)?.content?.[0]?.text === "live history message";
            })?.value as { messages?: SessionHistoryMessage[] } | undefined;
            expect(liveRetained?.messages).toHaveLength(retainedMessageLimit);
            expect(liveRetained?.messages?.at(-1)?.content?.[0]?.text).toBe("live history message");

            const refreshedCursorEvent = await readSseEvent(
              cursorStream.reader,
              cursorStream.streamState,
            );
            expect(refreshedCursorEvent.event).toBe("history");
            const refreshedCursorMessages =
              (refreshedCursorEvent.data as SessionHistoryBody).messages ?? [];
            expect(refreshedCursorMessages).toHaveLength(initialMessageCount);
            expect(refreshedCursorMessages[0]?.content?.[0]?.text).toBe("history message 1");

            const refreshedCursorSnapshot = snapshotSpy.mock.results.at(-1)?.value as
              | { messages?: SessionHistoryMessage[] }
              | undefined;
            expect(refreshedCursorSnapshot?.messages).toHaveLength(retainedMessageLimit);

            const completeHistory = await vi.waitFor(
              async () => await readSessionHistoryBody(harness.port, sessionKey),
              { interval: 25, timeout: 5_000 },
            );
            expect(completeHistory.messages).toHaveLength(initialMessageCount + 1);
            expect(completeHistory.messages?.[0]?.content?.[0]?.text).toBe("history message 1");
            expect(completeHistory.messages?.at(-1)?.content?.[0]?.text).toBe(
              "live history message",
            );
          } finally {
            await cursorStream.reader.cancel();
          }
        } finally {
          await stream.reader.cancel();
        }
      });
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  test("streams identity-only transcript updates over SSE", async () => {
    await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      await expectHistoryEventTexts(stream, ["first message"]);

      emitSessionTranscriptUpdate({
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
        target: {
          agentId: AGENT_ID,
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath,
        },
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
        seq: 3,
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
        seq: 3,
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
        seq: 2,
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
        seq: 4,
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
        seq: 2,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
