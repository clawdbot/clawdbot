/**
 * Tests persistence effects when chat abort requests complete.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChatRunState } from "../server-chat-state.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

type TranscriptLine = {
  message?: Record<string, unknown>;
};

type TestChatRunRecord =
  ReturnType<typeof createChatRunState>["runs"] extends Map<string, infer Record> ? Record : never;

function createAbortTestRunState(entries: Array<[string, Partial<TestChatRunRecord>]>) {
  const state = createChatRunState();
  for (const [runId, record] of entries) {
    Object.assign(state.getOrCreate(runId), record);
  }
  return state;
}

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  storePath: "",
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
        storePath: sessionEntryState.storePath,
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

const transcriptFixtures = new Map<string, { sessionId: string; storePath: string }>();
const fixtureDirs = new Set<string>();

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const fixture = transcriptFixtures.get(transcriptPath);
  if (!fixture) {
    throw new Error(`unknown transcript fixture: ${transcriptPath}`);
  }
  return (await loadTranscriptEvents({
    agentId: "main",
    sessionId: fixture.sessionId,
    sessionKey: "main",
    storePath: fixture.storePath,
  })) as TranscriptLine[];
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

function setMockSessionEntry(params: {
  sessionId: string;
  storePath: string;
  transcriptPath: string;
  hasEntry?: boolean;
}) {
  sessionEntryState.transcriptPath = params.transcriptPath;
  sessionEntryState.storePath = params.storePath;
  sessionEntryState.sessionId = params.sessionId;
  sessionEntryState.hasEntry = params.hasEntry ?? true;
  sessionEntryState.canonicalKey = "main";
  sessionEntryState.cfg = {};
  sessionEntryState.loadCalls = [];
}

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureDirs.add(dir);
  const sessionId = "sess-main";
  const storePath = path.join(dir, "sessions.json");
  const transcriptPath = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  // The accessor resolves transcript targets from the persisted store, so the
  // fixture seeds a real entry instead of relying on the mocked gateway wrapper.
  await replaceSessionEntry(
    { agentId: "main", sessionKey: "main", storePath },
    { sessionId, sessionFile: transcriptPath, updatedAt: Date.now() },
  );
  transcriptFixtures.set(transcriptPath, { sessionId, storePath });
  setMockSessionEntry({ transcriptPath, storePath, sessionId });
  return { transcriptPath, sessionId, storePath };
}

function appendTranscriptMessage(params: {
  idempotencyKey: string;
  message: Record<string, unknown>;
  sessionId: string;
  storePath: string;
}) {
  appendTranscriptMessageSync(
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: "main",
      storePath: params.storePath,
    },
    {
      idempotencyLookup: "caller-checked",
      message: {
        ...params.message,
        idempotencyKey: params.idempotencyKey,
      },
      now: 1,
    },
  );
}

async function createMissingEntryFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureDirs.add(dir);
  const storePath = path.join(dir, "sessions.json");
  const sessionId = "client-supplied-session";
  const transcriptPath = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  transcriptFixtures.set(transcriptPath, { sessionId, storePath });
  setMockSessionEntry({ transcriptPath, storePath, sessionId, hasEntry: false });
  return { sessionId };
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetAgentEventsForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  transcriptFixtures.clear();
  const dirs = [...fixtureDirs];
  fixtureDirs.clear();
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("chat abort transcript persistence", () => {
  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-abort-run-");
    const runId = "idem-abort-run-1";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunState: createAbortTestRunState([
        [runId, { buffer: "Partial from run abort", deltaSentAt: Date.now() }],
      ]),
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const [ok1, payload1] = requireLastRespondCall(respond);
    expect(ok1).toBe(true);
    expectAbortPayload(payload1, { runIds: [runId] });

    context.chatAbortControllers.set(runId, createActiveRun("main", { sessionId }));
    const retryRun = context.chatRunState.getOrCreate(runId);
    retryRun.buffer = "Partial from run abort";
    retryRun.deltaSentAt = Date.now();

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture(
      "openclaw-chat-abort-idempotency-collision-",
    );
    const runId = "idem-abort-collision";
    const idempotencyKey = `${runId}:assistant`;
    appendTranscriptMessage({
      idempotencyKey,
      sessionId,
      storePath,
      message: {
        role: "user",
        content: "colliding user key",
        timestamp: 1,
      },
    });

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunState: createAbortTestRunState([
        [runId, { buffer: "Partial after collision", deltaSentAt: Date.now() }],
      ]),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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
      chatRunState: createAbortTestRunState([
        ["run-a", { buffer: "Session abort partial", deltaSentAt: Date.now() }],
        ["run-b", { buffer: "   ", deltaSentAt: Date.now() }],
      ]),
    });

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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

  it("does not persist partials from finalizing runs that reject a session abort", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-finalizing-",
    );
    const respond = vi.fn();
    const finalizingRun = {
      ...createActiveRun("main", { sessionId }),
      isAbortable: () => false,
    };
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-aborted", createActiveRun("main", { sessionId })],
        ["run-finalizing", finalizingRun],
      ]),
      chatRunState: createAbortTestRunState([
        ["run-aborted", { buffer: "Aborted partial" }],
        ["run-finalizing", { buffer: "Completed reply" }],
      ]),
    });

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
      context,
      request: { sessionKey: "main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-aborted"] });
    expect(finalizingRun.controller.signal.aborted).toBe(false);
    expect(context.chatAbortControllers.get("run-finalizing")).toBe(finalizingRun);

    const lines = await readTranscriptLines(transcriptPath);
    expect(findMessageWithIdempotencyKey(lines, "run-aborted:assistant")).toBeDefined();
    expect(findMessageWithIdempotencyKey(lines, "run-finalizing:assistant")).toBeUndefined();
  });

  it("persists /stop partials with stop-command metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-stop-");
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-1", createActiveRun("main", { sessionId })]]),
      chatRunState: createAbortTestRunState([
        ["run-stop-1", { buffer: "Partial from /stop", deltaSentAt: Date.now() }],
      ]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "client-stop-1" }),
      agentRunSeq: new Map<string, number>([["run-stop-1", 1]]),
    });

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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
      chatRunState: createAbortTestRunState([
        ["run-work-global", { buffer: "partial work response" }],
      ]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "global",
        agentId: "work",
        clientRunId: "run-work-global",
      }),
    });

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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
      chatRunState: createAbortTestRunState([
        ["run-main-global", { buffer: "partial main response" }],
      ]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "global",
        agentId: "main",
        clientRunId: "run-main-global",
      }),
    });

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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
      await expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      )({
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

    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
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

    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
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

    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
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

    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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

  it("does not abort hidden pending internal agent runs by visible session key", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext();
    context.dedupe.set("agent:run-hidden", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "run-hidden",
        sessionKey: "main",
        status: "accepted",
        controlUiVisible: false,
        ownerConnId: "conn-hidden",
      },
    });

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
      context,
      request: {
        sessionKey: "main",
      },
      client: { connId: "conn-hidden" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    const actual = expectRecord(payload, "abort payload");
    expect(actual.aborted).toBe(false);
    expect(actual.runIds).toEqual([]);
    expect(context.dedupe.get("agent:run-hidden")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "accepted",
          controlUiVisible: false,
        }),
      }),
    );
  });

  it("aborts hidden pending internal agent runs by explicit owner run id", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext();
    context.dedupe.set("agent:run-hidden", {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: "run-hidden",
        sessionKey: "main",
        status: "accepted",
        controlUiVisible: false,
        ownerConnId: "conn-hidden",
      },
    });

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
      context,
      request: {
        sessionKey: "main",
        runId: "run-hidden",
      },
      client: { connId: "conn-hidden" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: ["run-hidden"] });
    expect(context.dedupe.get("agent:run-hidden")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "timeout",
          controlUiVisible: false,
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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
      chatRunState: createAbortTestRunState([
        [runId, { buffer: "  \n\t  ", deltaSentAt: Date.now() }],
      ]),
    });

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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

  it("skips run-scoped transcript persistence for hidden internal runs", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-hidden-",
    );
    const runId = "idem-abort-run-hidden";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        [runId, createActiveRun("main", { sessionId, controlUiVisible: false })],
      ]),
      chatRunState: createAbortTestRunState([
        [runId, { buffer: "Hidden partial", deltaSentAt: Date.now() }],
      ]),
    });

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
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

describe("chat.abort session identity matching", () => {
  it("matches an active run by stored sessionId when sessionKey differs", async () => {
    const storedSessionId = "sess-stored-abc";
    setMockSessionEntry({ transcriptPath: "", storePath: "", sessionId: storedSessionId });
    const runId = "embedded-run-1";
    const active = createActiveRun("agent:main:embedded-key", { sessionId: storedSessionId });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, active]]),
    });
    const respond = vi.fn();

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
      context,
      request: { sessionKey: "main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(active.controller.signal.aborted).toBe(true);
    expect(sessionEntryState.loadCalls).toContainEqual({ sessionKey: "main", opts: undefined });
  });

  it("does not match a run whose sessionId differs from the stored entry", async () => {
    setMockSessionEntry({ transcriptPath: "", storePath: "", sessionId: "sess-stored-xyz" });
    const runId = "embedded-run-2";
    const active = createActiveRun("agent:main:other-key", { sessionId: "sess-different" });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, active]]),
    });
    const respond = vi.fn();

    await invokeChatAbortHandler({
      handler: expectDefined(
        chatHandlers["chat.abort"],
        'chatHandlers["chat.abort"] test invariant',
      ),
      context,
      request: { sessionKey: "main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expect(payload).toEqual({ ok: true, aborted: false, runIds: [] });
    expect(active.controller.signal.aborted).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
