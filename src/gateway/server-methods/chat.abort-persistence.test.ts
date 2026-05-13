import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

type TranscriptLine = {
  message?: Record<string, unknown>;
};

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "",
}));

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(sessionEntryState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: sessionEntryState.sessionId,
        sessionFile: sessionEntryState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

async function writeTranscriptHeader(transcriptPath: string, sessionId: string) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  const lines: TranscriptLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      lines.push(JSON.parse(line) as TranscriptLine);
    } catch {
      lines.push({});
    }
  }
  return lines;
}

function collectMessagesWithIdempotencyKey(
  lines: TranscriptLine[],
  idempotencyKey: string,
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.message?.idempotencyKey === idempotencyKey) {
      messages.push(line.message);
    }
  }
  return messages;
}

function findMessageWithIdempotencyKey(
  lines: TranscriptLine[],
  idempotencyKey: string,
): Record<string, unknown> | undefined {
  for (const line of lines) {
    if (line.message?.idempotencyKey === idempotencyKey) {
      return line.message;
    }
  }
  return undefined;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectAbortPayload(payload: unknown, expected?: { runIds?: string[] }) {
  const actual = expectRecord(payload, "abort payload");
  expect(actual.aborted).toBe(true);
  if (expected?.runIds) {
    expect(actual.runIds).toEqual(expected.runIds);
  }
  return actual;
}

function expectAbortPayloadContainsRunIds(payload: unknown, runIds: string[]) {
  const actual = expectAbortPayload(payload);
  expect(Array.isArray(actual.runIds)).toBe(true);
  for (const runId of runIds) {
    expect(actual.runIds as unknown[]).toContain(runId);
  }
}

function requireLastRespondCall(respond: ReturnType<typeof vi.fn>): unknown[] {
  const calls = respond.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

function expectPersistedAbortMessage(
  message: unknown,
  expected: {
    idempotencyKey: string;
    origin: string;
    runId: string;
    stopReason?: string;
  },
) {
  const actual = expectRecord(message, "persisted abort message");
  expect(actual.idempotencyKey).toBe(expected.idempotencyKey);
  if (expected.stopReason) {
    expect(actual.stopReason).toBe(expected.stopReason);
  }
  const abort = expectRecord(actual.openclawAbort, "persisted abort metadata");
  expect(abort.aborted).toBe(true);
  expect(abort.origin).toBe(expected.origin);
  expect(abort.runId).toBe(expected.runId);
}

function setMockSessionEntry(transcriptPath: string, sessionId: string) {
  sessionEntryState.transcriptPath = transcriptPath;
  sessionEntryState.sessionId = sessionId;
}

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = "sess-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await writeTranscriptHeader(transcriptPath, sessionId);
  setMockSessionEntry(transcriptPath, sessionId);
  return { transcriptPath, sessionId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat abort transcript persistence", () => {
  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-abort-run-");
    const runId = "idem-abort-run-1";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "Partial from run abort"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
      removeChatRun: vi
        .fn()
        .mockReturnValue({ sessionKey: "main", clientRunId: "client-idem-abort-run-1" }),
      agentRunSeq: new Map<string, number>([
        [runId, 2],
        ["client-idem-abort-run-1", 3],
      ]),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const [ok1, payload1] = requireLastRespondCall(respond);
    expect(ok1).toBe(true);
    expectAbortPayload(payload1, { runIds: [runId] });

    context.chatAbortControllers.set(runId, createActiveRun("main", { sessionId }));
    context.chatRunBuffers.set(runId, "Partial from run abort");
    context.chatDeltaSentAt.set(runId, Date.now());

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = collectMessagesWithIdempotencyKey(lines, `${runId}:assistant`);

    expect(persisted).toHaveLength(1);
    expectPersistedAbortMessage(persisted[0], {
      idempotencyKey: `${runId}:assistant`,
      origin: "rpc",
      runId,
      stopReason: "stop",
    });
  });

  it("persists session-scoped abort partials with rpc metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-session-",
    );
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-a", createActiveRun("main", { sessionId })],
        ["run-b", createActiveRun("main", { sessionId })],
      ]),
      chatRunBuffers: new Map([
        ["run-a", "Session abort partial"],
        ["run-b", "   "],
      ]),
      chatDeltaSentAt: new Map([
        ["run-a", Date.now()],
        ["run-b", Date.now()],
      ]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayloadContainsRunIds(payload, ["run-a", "run-b"]);

    const lines = await readTranscriptLines(transcriptPath);
    const runAPersisted = findMessageWithIdempotencyKey(lines, "run-a:assistant");
    const runBPersisted = findMessageWithIdempotencyKey(lines, "run-b:assistant");

    expectPersistedAbortMessage(runAPersisted, {
      idempotencyKey: "run-a:assistant",
      origin: "rpc",
      runId: "run-a",
    });
    expect(runBPersisted).toBeUndefined();
  });

  it("persists /stop partials with stop-command metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-stop-");
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-1", createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([["run-stop-1", "Partial from /stop"]]),
      chatDeltaSentAt: new Map([["run-stop-1", Date.now()]]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "client-stop-1" }),
      agentRunSeq: new Map<string, number>([["run-stop-1", 1]]),
      dedupe: {
        get: vi.fn(),
      },
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "idem-stop-req",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-stop-1"] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = findMessageWithIdempotencyKey(lines, "run-stop-1:assistant");

    expectPersistedAbortMessage(persisted, {
      idempotencyKey: "run-stop-1:assistant",
      origin: "stop-command",
      runId: "run-stop-1",
    });
  });

  it("skips run-scoped transcript persistence when partial text is blank", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-blank-",
    );
    const runId = "idem-abort-run-blank";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "  \n\t  "]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = findMessageWithIdempotencyKey(lines, `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });
});
