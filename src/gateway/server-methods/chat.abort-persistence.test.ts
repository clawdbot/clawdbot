/**
 * Tests persistence effects when chat abort requests complete.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChatRunState } from "../server-chat-state.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { captureAbortedPartial, persistAbortedPartials } from "./chat-abort-runtime.js";
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
  lifecycleRevision: undefined as string | undefined,
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
        agentId: opts?.agentId ?? "main",
        storePath: sessionEntryState.storePath,
        entry: sessionEntryState.hasEntry
          ? {
              sessionId: sessionEntryState.sessionId,
              lifecycleRevision: sessionEntryState.lifecycleRevision,
              sessionFile: sessionEntryState.transcriptPath,
            }
          : undefined,
        canonicalKey: sessionEntryState.canonicalKey,
      };
    },
  };
});

const { chatHandlers } = await import("./chat.js");

const transcriptFixtures = new Map<
  string,
  { sessionId: string; storePath: string; agentId: string; sessionKey: string }
>();
const fixtureDirs = new Set<string>();

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const fixture = transcriptFixtures.get(transcriptPath);
  if (!fixture) {
    throw new Error(`unknown transcript fixture: ${transcriptPath}`);
  }
  return (await loadTranscriptEvents({
    agentId: fixture.agentId,
    sessionId: fixture.sessionId,
    sessionKey: fixture.sessionKey,
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

function collectAssistantRowsWithText(
  lines: TranscriptLine[],
  text: string,
): Record<string, unknown>[] {
  return lines
    .map((line) => line.message)
    .filter(
      (message): message is Record<string, unknown> =>
        message?.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            (block as { text?: unknown }).text === text,
        ),
    );
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
  sessionEntryState.lifecycleRevision = undefined;
  sessionEntryState.canonicalKey = "agent:main:main";
  sessionEntryState.cfg = {};
  sessionEntryState.loadCalls = [];
}

async function createTranscriptFixture(
  prefix: string,
  owner = { agentId: "main", sessionKey: "main" },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureDirs.add(dir);
  const sessionId = "sess-main";
  const storePath = path.join(dir, "sessions.json");
  const transcriptPath = formatSqliteSessionFileMarker({
    agentId: owner.agentId,
    sessionId,
    storePath,
  });
  // The accessor resolves transcript targets from the persisted store, so the
  // fixture seeds a real entry instead of relying on the mocked gateway wrapper.
  await replaceSessionEntry(
    { ...owner, storePath },
    { sessionId, sessionFile: transcriptPath, updatedAt: Date.now() },
  );
  transcriptFixtures.set(transcriptPath, { sessionId, storePath, ...owner });
  setMockSessionEntry({ transcriptPath, storePath, sessionId });
  return { transcriptPath, sessionId, storePath };
}

function appendTranscriptMessage(params: {
  idempotencyKey: string;
  message: Record<string, unknown>;
  sessionId: string;
  storePath: string;
}) {
  const seeded = appendTranscriptMessageSync(
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
  expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });
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
  transcriptFixtures.set(transcriptPath, {
    sessionId,
    storePath,
    agentId: "main",
    sessionKey: "main",
  });
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
  // Abort persistence can still be flushing SQLite sidecar files when cleanup
  // starts; retries absorb the ENOTEMPTY window instead of failing the test.
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("chat abort transcript persistence", () => {
  it("publishes one run-owned transcript row for an abandoned placement partial", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-placement-abandon-",
    );
    const runId = "placement-abandon-run";
    const updates: unknown[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    const snapshot = captureAbortedPartial({
      sessionKey: "main",
      runId,
      sessionId,
      agentId: "main",
      text: "Gateway-synced remote partial",
      abortOrigin: "placement-abandon" as const,
    });

    try {
      await persistAbortedPartials({
        context: { logGateway: { warn: vi.fn() } },
        snapshots: [snapshot],
      });
      await persistAbortedPartials({
        context: { logGateway: { warn: vi.fn() } },
        snapshots: [snapshot],
      });
    } finally {
      unsubscribe();
    }

    const persisted = collectMessagesWithIdempotencyKey(
      await readTranscriptLines(transcriptPath),
      `${runId}:assistant`,
    );
    expect(persisted).toHaveLength(1);
    expectPersistedAbortMessage(persisted[0], {
      idempotencyKey: `${runId}:assistant`,
      origin: "placement-abandon",
      runId,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ runId, messageId: expect.any(String), messageSeq: 1 });
  });

  it.each([
    { origin: "placement-abandon" as const, rejects: true },
    { origin: "rpc" as const, rejects: false },
  ])("keeps $origin append failure at its owning abort boundary", async ({ origin, rejects }) => {
    const { sessionId } = await createTranscriptFixture("openclaw-chat-abort-append-failure-");
    sessionEntryState.storePath = "";
    const warn = vi.fn();
    const persistence = persistAbortedPartials({
      context: { logGateway: { warn } },
      snapshots: [
        captureAbortedPartial({
          sessionKey: "main",
          sessionId,
          agentId: "main",
          runId: "failed-abort-run",
          text: "partial that cannot be persisted",
          abortOrigin: origin,
        }),
      ],
    });

    if (rejects) {
      await expect(persistence).rejects.toThrow("transcript identity not resolved");
    } else {
      await expect(persistence).resolves.toBeUndefined();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("transcript identity not resolved"));
  });

  it("rejects an abandoned partial after its exact transcript session is replaced", async () => {
    const { sessionId } = await createTranscriptFixture("openclaw-chat-abort-rebound-session-");

    await expect(
      persistAbortedPartials({
        context: { logGateway: { warn: vi.fn() } },
        snapshots: [
          captureAbortedPartial({
            sessionKey: "main",
            sessionId: `${sessionId}-stale`,
            agentId: "main",
            runId: "stale-placement-run",
            text: "partial from the former session",
            abortOrigin: "placement-abandon",
          }),
        ],
      }),
    ).rejects.toThrow("transcript session changed");
  });

  it.each([undefined, "original-revision"])(
    "rejects placement partials when captured revision %s changes without SID rotation",
    async (lifecycleRevision) => {
      const { transcriptPath, sessionId, storePath } = await createTranscriptFixture(
        "openclaw-chat-placement-revision-",
      );
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: "main" },
        {
          sessionId,
          updatedAt: Date.now(),
          lifecycleRevision,
        },
      );
      sessionEntryState.lifecycleRevision = lifecycleRevision;
      const snapshot = captureAbortedPartial({
        sessionKey: "main",
        sessionId,
        agentId: "main",
        runId: "placement-revision",
        text: "obsolete placement partial",
        abortOrigin: "placement-abandon",
      });
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: "main" },
        {
          sessionId,
          updatedAt: Date.now(),
          lifecycleRevision: "next-revision",
        },
      );
      const before = await readTranscriptLines(transcriptPath);
      await expect(
        persistAbortedPartials({
          context: { logGateway: { warn: vi.fn() } },
          snapshots: [snapshot],
        }),
      ).rejects.toThrow("session-rebound");
      expect(await readTranscriptLines(transcriptPath)).toEqual(before);
    },
  );

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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
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

  it("does not duplicate a committed reply when a late abort re-persists the buffered text", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture(
      "openclaw-chat-abort-committed-reply-",
    );
    // The embedded agent loop persists its final assistant row without a
    // run-scoped idempotency key, so the store-level key dedupe cannot see
    // it; only the attached run identity can scope the skip to this run.
    const seeded = appendTranscriptMessageSync(
      { agentId: "main", sessionId, sessionKey: "main", storePath },
      {
        idempotencyLookup: "caller-checked",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Completed reply" }],
          timestamp: Date.now(),
          stopReason: "stop",
          __openclaw: { runId: "stalled-committed-run" },
        },
        now: 1,
      },
    );
    expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });

    // Settlement stall: the run committed its row but never emitted its
    // terminal lifecycle event, so the gateway still projects it active with
    // the full reply buffered.
    const runId = "stalled-committed-run";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunState: createAbortTestRunState([[runId, { buffer: "Completed reply" }]]),
      removeChatRun: vi
        .fn()
        .mockReturnValue({ sessionKey: "main", clientRunId: "client-stalled-committed-run" }),
      agentRunSeq: new Map<string, number>([
        [runId, 2],
        ["client-stalled-committed-run", 3],
      ]),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbortHandler({
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const committedRows = collectAssistantRowsWithText(lines, "Completed reply");

    expect(committedRows).toHaveLength(1);
    expect(committedRows[0]?.openclawAbort).toBeUndefined();
  });

  it("keeps an abort partial when the committed reply belongs to a different run", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture(
      "openclaw-chat-abort-cross-run-",
    );
    // An earlier run committed the identical reply. Text equality alone would
    // drop this run's abort partial, so the skip must be run-scoped.
    const seeded = appendTranscriptMessageSync(
      { agentId: "main", sessionId, sessionKey: "main", storePath },
      {
        idempotencyLookup: "caller-checked",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Completed reply" }],
          timestamp: Date.now(),
          stopReason: "stop",
          __openclaw: { runId: "settled-other-run" },
        },
        now: 1,
      },
    );
    expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });

    await persistAbortedPartials({
      context: { logGateway: { warn: vi.fn() } },
      snapshots: [
        captureAbortedPartial({
          sessionKey: "main",
          runId: "aborted-later-run",
          sessionId,
          agentId: "main",
          text: "Completed reply",
          abortOrigin: "rpc",
        }),
      ],
    });

    const lines = await readTranscriptLines(transcriptPath);
    const committedRows = collectAssistantRowsWithText(lines, "Completed reply");
    expect(committedRows).toHaveLength(2);
    expectPersistedAbortMessage(committedRows[1], {
      idempotencyKey: "aborted-later-run:assistant",
      origin: "rpc",
      runId: "aborted-later-run",
    });
  });

  it("keeps an abort partial when the committed row predates run identity tagging", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture(
      "openclaw-chat-abort-legacy-row-",
    );
    const seeded = appendTranscriptMessageSync(
      { agentId: "main", sessionId, sessionKey: "main", storePath },
      {
        idempotencyLookup: "caller-checked",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Completed reply" }],
          timestamp: Date.now(),
          stopReason: "stop",
        },
        now: 1,
      },
    );
    expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });

    // A row without a stored run identity cannot prove this run's reply is
    // committed; losing the abort record is worse than a duplicate reply.
    await persistAbortedPartials({
      context: { logGateway: { warn: vi.fn() } },
      snapshots: [
        captureAbortedPartial({
          sessionKey: "main",
          runId: "aborted-unproven-run",
          sessionId,
          agentId: "main",
          text: "Completed reply",
          abortOrigin: "rpc",
        }),
      ],
    });

    const lines = await readTranscriptLines(transcriptPath);
    const committedRows = collectAssistantRowsWithText(lines, "Completed reply");
    expect(committedRows).toHaveLength(2);
    expectPersistedAbortMessage(committedRows[1], {
      idempotencyKey: "aborted-unproven-run:assistant",
      origin: "rpc",
      runId: "aborted-unproven-run",
    });
  });

  it("treats a declined committed-reply skip as a decision, not a placement-abandon failure", async () => {
    const { transcriptPath, sessionId, storePath } = await createTranscriptFixture(
      "openclaw-chat-abort-skip-decision-",
    );
    const seeded = appendTranscriptMessageSync(
      { agentId: "main", sessionId, sessionKey: "main", storePath },
      {
        idempotencyLookup: "caller-checked",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Completed reply" }],
          timestamp: Date.now(),
          stopReason: "stop",
          __openclaw: { runId: "stalled-placement-run" },
        },
        now: 1,
      },
    );
    expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });

    // The skip happens inside the writer queue after the append decision was
    // handed off, so it must not surface as a failed placement abandonment.
    await persistAbortedPartials({
      context: { logGateway: { warn: vi.fn() } },
      snapshots: [
        captureAbortedPartial({
          sessionKey: "main",
          runId: "stalled-placement-run",
          sessionId,
          agentId: "main",
          text: "Completed reply",
          abortOrigin: "placement-abandon",
        }),
      ],
    });

    const lines = await readTranscriptLines(transcriptPath);
    const committedRows = collectAssistantRowsWithText(lines, "Completed reply");
    expect(committedRows).toHaveLength(1);
    expect(committedRows[0]?.openclawAbort).toBeUndefined();
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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
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

  it.each([
    [
      "plain stop aborts runs tracked under the canonical session key",
      "canonical",
      "main",
      "alias-main",
    ],
    [
      "plain stop aborts raw-alias runs for the same backing session",
      "raw-alias",
      "alias-main",
      "main",
    ],
  ])("%s", async (_name, caseId, activeSessionKey, requestedSessionKey) => {
    const { sessionId } = await createTranscriptFixture(`openclaw-chat-stop-${caseId}-`);
    const respond = vi.fn();
    const runId = `run-stop-${caseId}`;
    const active = createActiveRun(activeSessionKey, { sessionId });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, active]]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: activeSessionKey, clientRunId: runId }),
    });

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: requestedSessionKey,
        message: "stop",
        idempotencyKey: `idem-stop-${caseId}`,
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(active.controller.signal.aborted).toBe(true);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
  });

  it.each([
    ["scopes global stop commands to the selected agent", "work", "agent"],
    ["scopes bare global stop commands to the default agent", "main", "default"],
  ])("%s", async (_name, selectedAgentId, fixtureId) => {
    const { sessionId, transcriptPath } = await createTranscriptFixture(
      `openclaw-chat-stop-global-${fixtureId}-`,
      {
        agentId: selectedAgentId,
        sessionKey: "global",
      },
    );
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" as const },
    };
    sessionEntryState.canonicalKey = "global";
    sessionEntryState.cfg = cfg;
    const respond = vi.fn();
    const mainActive = createActiveRun("global", {
      sessionId: selectedAgentId === "main" ? sessionId : "sess-main-global",
      agentId: "main",
    });
    const workActive = createActiveRun("global", {
      sessionId: selectedAgentId === "work" ? sessionId : "sess-work-global",
      agentId: "work",
    });
    const runId = `run-${selectedAgentId}-global`;
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-main-global", mainActive],
        ["run-work-global", workActive],
      ]),
      chatRunState: createAbortTestRunState([
        [runId, { buffer: `partial ${selectedAgentId} response` }],
      ]),
      removeChatRun: vi.fn().mockReturnValue({
        sessionKey: "global",
        agentId: selectedAgentId,
        clientRunId: runId,
      }),
      getRuntimeConfig: () => cfg,
    });

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "global",
        ...(selectedAgentId === "work" ? { agentId: selectedAgentId } : {}),
        message: "stop",
        idempotencyKey: `idem-stop-${selectedAgentId === "work" ? "work" : "default"}-global`,
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(mainActive.controller.signal.aborted).toBe(selectedAgentId === "main");
    expect(workActive.controller.signal.aborted).toBe(selectedAgentId === "work");
    expect(
      findMessageWithIdempotencyKey(
        await readTranscriptLines(transcriptPath),
        `${runId}:assistant`,
      ),
    ).toBeDefined();
    expect(context.logGateway.warn).not.toHaveBeenCalled();
    if (selectedAgentId === "work") {
      expect(sessionEntryState.loadCalls).toContainEqual({
        sessionKey: "global",
        opts: { agentId: "work" },
      });
    }
  });

  it.each([
    ["scopes global chat.abort requests to the selected agent", "global", "work", false],
    ["scopes bare global chat.abort requests to the default agent", "global", undefined, true],
    [
      "infers selected global chat.abort scope from agent-prefixed aliases",
      "agent:work:main",
      undefined,
      true,
    ],
  ])("%s", async (_name, sessionKey, agentId, needsGlobalConfig) => {
    const expectedAgentId = agentId ?? (sessionKey.startsWith("agent:work:") ? "work" : "main");
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" as const },
    };
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
      getRuntimeConfig: () => cfg,
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
      await handleChatAbortRequest({
        params: { sessionKey, ...(agentId ? { agentId } : {}) },
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
    expectAbortPayload(payload, { runIds: [`run-${expectedAgentId}-global`] });
    expect(mainActive.controller.signal.aborted).toBe(expectedAgentId === "main");
    expect(workActive.controller.signal.aborted).toBe(expectedAgentId === "work");
    if (!needsGlobalConfig) {
      expect(agentEvents).toContainEqual({
        runId: "run-work-global",
        sessionKey: "global",
        agentId: "work",
      });
    }
  });

  it("rejects selected global chat.abort when agentId conflicts with the key agent", async () => {
    const respond = vi.fn();
    const context = createChatAbortContext({
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global" },
      }),
    });

    await handleChatAbortRequest({
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

    await handleChatAbortRequest({
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
      handler: handleChatAbortRequest,
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

  it.each([
    ["does not abort hidden pending internal agent runs by visible session key", false],
    ["aborts hidden pending internal agent runs by explicit owner run id", true],
  ])("%s", async (_name, explicitRunId) => {
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
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey: "main", ...(explicitRunId ? { runId: "run-hidden" } : {}) },
      client: { connId: "conn-hidden" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    const actual = expectRecord(payload, "abort payload");
    expect(actual.aborted).toBe(explicitRunId);
    expect(actual.runIds).toEqual(explicitRunId ? ["run-hidden"] : []);
    expect(context.dedupe.get("agent:run-hidden")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: explicitRunId ? "timeout" : "accepted",
          controlUiVisible: false,
          ...(explicitRunId ? { stopReason: "rpc" } : {}),
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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
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

  it.each([
    ["does not abort pending default global agent runs for another selected agent", "work", false],
    ["aborts pending default global agent runs for the default selected agent", "main", true],
  ])("%s", async (_name, agentId, shouldAbort) => {
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
        sessionKey: "global",
        status: "accepted",
        ownerConnId: "conn-main",
      },
    });

    await invokeChatAbortHandler({
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey: "global", agentId, runId: "run-main-global" },
      client: { connId: "conn-main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    const actual = expectRecord(payload, "abort payload");
    expect(actual.aborted).toBe(shouldAbort);
    expect(actual.runIds).toEqual(shouldAbort ? ["run-main-global"] : []);
    expect(context.dedupe.get("agent:run-main-global")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: shouldAbort ? "timeout" : "accepted",
          ...(shouldAbort ? { stopReason: "rpc" } : {}),
        }),
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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
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
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey: "main" },
      respond,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { runIds: [runId] });
    expect(active.controller.signal.aborted).toBe(true);
    expect(sessionEntryState.loadCalls).toContainEqual({
      sessionKey: "agent:main:main",
      opts: { agentId: "main" },
    });
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
      handler: handleChatAbortRequest,
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
