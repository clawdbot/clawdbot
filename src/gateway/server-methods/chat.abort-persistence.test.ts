import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
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
  hasEntry: true,
  canonicalKey: "main",
  cfg: {} as Record<string, unknown>,
  loadCalls: [] as Array<{ sessionKey: string; opts?: { agentId?: string } }>,
}));

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadSessionEntry: (sessionKey: string, opts?: { agentId?: string }) => {
      sessionEntryState.loadCalls.push({ sessionKey, opts });
      return {
        cfg: sessionEntryState.cfg,
        storePath: path.join(path.dirname(sessionEntryState.transcriptPath), "sessions.json"),
        entry: sessionEntryState.hasEntry
          ? {
              sessionId: sessionEntryState.sessionId,
              sessionFile: sessionEntryState.transcriptPath,
            }
          : undefined,
        canonicalKey: sessionEntryState.canonicalKey,
      };
    },
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

function setMockSessionEntry(transcriptPath: string, sessionId: string, hasEntry = true) {
  sessionEntryState.transcriptPath = transcriptPath;
  sessionEntryState.sessionId = sessionId;
  sessionEntryState.hasEntry = hasEntry;
  sessionEntryState.canonicalKey = "main";
  sessionEntryState.cfg = {};
  sessionEntryState.loadCalls = [];
}

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = "sess-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await writeTranscriptHeader(transcriptPath, sessionId);
  setMockSessionEntry(transcriptPath, sessionId);
  return { transcriptPath, sessionId };
}

async function createMissingEntryFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const transcriptPath = path.join(dir, "missing.jsonl");
  const sessionId = "client-supplied-session";
  setMockSessionEntry(transcriptPath, sessionId, false);
  return { sessionId };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentEventsForTest();
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

  it("does not let non-assistant idempotency collisions suppress abort partial persistence", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-idempotency-collision-",
    );
    const runId = "idem-abort-collision";
    const idempotencyKey = `${runId}:assistant`;
    await fs.appendFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "user-message-with-colliding-key",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: "user",
          content: "colliding user key",
          timestamp: 1,
          idempotencyKey,
        },
      })}\n`,
      "utf-8",
    );

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "Partial after collision"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const assistantMessages = collectMessagesWithIdempotencyKey(lines, idempotencyKey).filter(
      (message) => message.role === "assistant",
    );

    expect(assistantMessages).toHaveLength(1);
    expectPersistedAbortMessage(assistantMessages[0], {
      idempotencyKey,
      origin: "rpc",
      runId,
      stopReason: "stop",
    });
  });

  it("dedupes legacy assistant transcript entries without top-level ids", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-legacy-idempotency-",
    );
    const runId = "idem-abort-legacy";
    const idempotencyKey = `${runId}:assistant`;
    await fs.appendFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        timestamp: new Date(0).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "legacy partial" }],
          timestamp: 1,
          stopReason: "stop",
          api: "openai-responses",
          provider: "openclaw",
          model: "gateway-injected",
          idempotencyKey,
          openclawAbort: {
            aborted: true,
            origin: "rpc",
            runId,
          },
        },
      })}\n`,
      "utf-8",
    );

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "Duplicate partial"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const assistantMessages = collectMessagesWithIdempotencyKey(lines, idempotencyKey).filter(
      (message) => message.role === "assistant",
    );

    expect(assistantMessages).toHaveLength(1);
    expectPersistedAbortMessage(assistantMessages[0], {
      idempotencyKey,
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

  it("plain stop aborts runs tracked under the canonical session key", async () => {
    const { sessionId } = await createTranscriptFixture("openclaw-chat-stop-canonical-");
    const respond = vi.fn();
    const active = createActiveRun("main", { sessionId });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-canonical", active]]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "main",
        clientRunId: "run-stop-canonical",
      }),
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "alias-main",
        message: "stop",
        idempotencyKey: "idem-stop-canonical",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-stop-canonical"] });
    expect(active.controller.signal.aborted).toBe(true);
    expect(context.chatAbortControllers.has("run-stop-canonical")).toBe(false);
  });

  it("plain stop aborts raw-alias runs for the same backing session", async () => {
    const { sessionId } = await createTranscriptFixture("openclaw-chat-stop-raw-alias-");
    const respond = vi.fn();
    const active = createActiveRun("alias-main", { sessionId });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-raw-alias", active]]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "alias-main",
        clientRunId: "run-stop-raw-alias",
      }),
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "stop",
        idempotencyKey: "idem-stop-raw-alias",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-stop-raw-alias"] });
    expect(active.controller.signal.aborted).toBe(true);
    expect(context.chatAbortControllers.has("run-stop-raw-alias")).toBe(false);
  });

  it("scopes global stop commands to the selected agent", async () => {
    const { sessionId } = await createTranscriptFixture("openclaw-chat-stop-global-agent-");
    sessionEntryState.canonicalKey = "global";
    sessionEntryState.cfg = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: "sess-main-global",
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId,
      agentId: "work",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
      chatRunBuffers: new Map([["run-work-global", "partial work response"]]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "global",
        agentId: "work",
        clientRunId: "run-work-global",
      }),
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "global",
        agentId: "work",
        message: "stop",
        idempotencyKey: "idem-stop-work-global",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(mainActive.controller.signal.aborted).toBe(false);
    expect(workActive.controller.signal.aborted).toBe(true);
    expect(sessionEntryState.loadCalls).toContainEqual({
      sessionKey: "global",
      opts: { agentId: "work" },
    });
  });

  it("scopes bare global stop commands to the default agent", async () => {
    const { sessionId } = await createTranscriptFixture("openclaw-chat-stop-global-default-");
    sessionEntryState.canonicalKey = "global";
    sessionEntryState.cfg = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId,
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
      chatRunBuffers: new Map([["run-main-global", "partial main response"]]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "global",
        agentId: "main",
        clientRunId: "run-main-global",
      }),
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "global",
        message: "stop",
        idempotencyKey: "idem-stop-default-global",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-main-global"] });
    expect(mainActive.controller.signal.aborted).toBe(true);
    expect(workActive.controller.signal.aborted).toBe(false);
  });

  it("scopes global chat.abort requests to the selected agent", async () => {
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: "sess-main-global",
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
    });
    const agentEvents: Array<{ runId: string; sessionKey?: string; agentId?: string }> = [];
    const unsubscribe = onAgentEvent((event) => {
      agentEvents.push({
        runId: event.runId,
        sessionKey: event.sessionKey,
        agentId: event.agentId,
      });
    });

    try {
      await chatHandlers["chat.abort"]({
        params: {
          sessionKey: "global",
          agentId: "work",
        },
        respond,
        context: context as never,
        req: {} as never,
        client: null,
        isWebchatConnect: () => false,
      });
    } finally {
      unsubscribe();
    }

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(mainActive.controller.signal.aborted).toBe(false);
    expect(workActive.controller.signal.aborted).toBe(true);
    expect(agentEvents).toContainEqual({
      runId: "run-work-global",
      sessionKey: "global",
      agentId: "work",
    });
  });

  it("scopes bare global chat.abort requests to the default agent", async () => {
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: "sess-main-global",
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    });

    await chatHandlers["chat.abort"]({
      params: {
        sessionKey: "global",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-main-global"] });
    expect(mainActive.controller.signal.aborted).toBe(true);
    expect(workActive.controller.signal.aborted).toBe(false);
  });

  it("infers selected global chat.abort scope from agent-prefixed aliases", async () => {
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: "sess-main-global",
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    });

    await chatHandlers["chat.abort"]({
      params: {
        sessionKey: "agent:work:main",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(mainActive.controller.signal.aborted).toBe(false);
    expect(workActive.controller.signal.aborted).toBe(true);
  });

  it("rejects selected global chat.abort when agentId conflicts with the key agent", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext({
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    });

    await chatHandlers["chat.abort"]({
      params: {
        sessionKey: "agent:main:main",
        agentId: "work",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, , error] = requireLastRespondCall(respond);
    expect(ok).toBe(false);
    expect(error).toEqual(
      expect.objectContaining({
        message: 'agentId "work" does not match session key "agent:main:main"',
      }),
    );
  });

  it("accepts selected global chat.abort run ids with agent-prefixed aliases", async () => {
    const respond = vi.fn();
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-work-global", workActive]]),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    });

    await chatHandlers["chat.abort"]({
      params: {
        sessionKey: "agent:work:main",
        runId: "run-work-global",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(workActive.controller.signal.aborted).toBe(true);
  });

  it("aborts pending selected global agent runs stored under agent-prefixed aliases", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext({
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    });
    context.dedupe.set("agent:run-work-global", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "run-work-global",
        sessionKey: "agent:work:main",
        agentId: "work",
        status: "accepted",
        ownerConnId: "conn-work",
      },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: {
        sessionKey: "agent:work:main",
        runId: "run-work-global",
      },
      client: { connId: "conn-work" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(context.dedupe.get("agent:run-work-global")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionKey: "agent:work:main",
          status: "timeout",
          stopReason: "rpc",
        }),
      }),
    );
  });

  it("does not abort pending agent-prefixed global aliases for another selected agent", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext({
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    });
    context.dedupe.set("agent:run-main-global", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "run-main-global",
        sessionKey: "agent:main:main",
        agentId: "main",
        status: "accepted",
        ownerConnId: "conn-main",
      },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: {
        sessionKey: "agent:work:main",
        runId: "run-main-global",
      },
      client: { connId: "conn-main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    const actual = expectRecord(payload, "abort payload");
    expect(actual.aborted).toBe(false);
    expect(actual.runIds).toEqual([]);
    expect(context.dedupe.get("agent:run-main-global")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionKey: "agent:main:main",
          status: "accepted",
        }),
      }),
    );
  });

  it("treats unscoped global runs as default-agent abort targets", async () => {
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: "sess-main-global",
    });
    const workActive = createActiveRun("global", {
      sessionId: "sess-work-global",
      agentId: "work",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: {
        sessionKey: "global",
        agentId: "main",
      },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-main-global"] });
    expect(mainActive.controller.signal.aborted).toBe(true);
    expect(workActive.controller.signal.aborted).toBe(false);
  });

  it("accepts default-agent runId aborts for legacy unscoped global runs", async () => {
    const respond = vi.fn();
    const active = createActiveRun("global", {
      sessionId: "sess-main-global",
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-main-global", active]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: {
        sessionKey: "global",
        agentId: "main",
        runId: "run-main-global",
      },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-main-global"] });
    expect(active.controller.signal.aborted).toBe(true);
  });

  it("uses the configured default agent for legacy unscoped global aborts", async () => {
    const respond = vi.fn();
    const active = createActiveRun("global", {
      sessionId: "sess-work-global",
    });
    const context = createChatAbortContext({
      getRuntimeConfig: () => ({ agents: { list: [{ id: "work", default: true }] } }),
      chatAbortControllers: new Map([["run-work-global", active]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: {
        sessionKey: "global",
        agentId: "work",
      },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-work-global"] });
    expect(active.controller.signal.aborted).toBe(true);
  });

  it("does not abort pending default global agent runs for another selected agent", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext();
    context.dedupe.set("agent:run-main-global", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "run-main-global",
        sessionKey: "global",
        status: "accepted",
        ownerConnId: "conn-main",
      },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: {
        sessionKey: "global",
        agentId: "work",
        runId: "run-main-global",
      },
      client: { connId: "conn-main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    const actual = expectRecord(payload, "abort payload");
    expect(actual.aborted).toBe(false);
    expect(actual.runIds).toEqual([]);
    expect(context.dedupe.get("agent:run-main-global")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ status: "accepted" }),
      }),
    );
  });

  it("aborts pending default global agent runs for the default selected agent", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext();
    context.dedupe.set("agent:run-main-global", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "run-main-global",
        sessionKey: "global",
        status: "accepted",
        ownerConnId: "conn-main",
      },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: {
        sessionKey: "global",
        agentId: "main",
        runId: "run-main-global",
      },
      client: { connId: "conn-main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-main-global"] });
    expect(context.dedupe.get("agent:run-main-global")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ status: "timeout", stopReason: "rpc" }),
      }),
    );
  });

  it("does not match stop targets by client-supplied session id without a stored entry", async () => {
    const { sessionId } = await createMissingEntryFixture("openclaw-chat-stop-client-session-");
    const respond = vi.fn();
    const active = createActiveRun("third-session", { sessionId });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-client-session", active]]),
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "other-session",
        sessionId,
        message: "stop",
        idempotencyKey: "idem-stop-client-session",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expect(expectRecord(payload, "abort payload").aborted).toBe(false);
    expect(active.controller.signal.aborted).toBe(false);
    expect(context.chatAbortControllers.has("run-stop-client-session")).toBe(true);
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
