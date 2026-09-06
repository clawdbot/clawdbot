// Import-safe state proof helpers: runtime operations are injected after child isolation.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as pollDelay } from "node:timers/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { QaBusState, QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  COMPACTION_PROOF_MODEL_ID as MODEL_ID,
  COMPACTION_PROOF_TIMEOUT_MS as CHECKPOINT_TIMEOUT_MS,
  COMPACTION_PROOF_TOOL_CALL_ID as TOOL_CALL_ID,
  recordCompactionProofCheckpoint,
  type CompactionProofCase as ProofCase,
} from "./gateway-compaction-provider.fixture.js";

type StateRuntime = {
  sessions: {
    SessionManager: Pick<
      typeof import("openclaw/plugin-sdk/agent-sessions").SessionManager,
      "open"
    >;
  };
  store: Pick<
    typeof import("openclaw/plugin-sdk/session-store-runtime"),
    "resolveStorePath" | "upsertSessionEntry" | "loadTranscriptEventsSync"
  >;
  transcript: Pick<
    typeof import("openclaw/plugin-sdk/session-transcript-runtime"),
    "appendSessionTranscriptMessageByIdentity"
  >;
  claimAgentSessionWriter: typeof import("../../../../src/agents/embedded-agent-runner/run/session-bootstrap.js").claimAgentSessionWriter;
  loadSessionEntry: typeof import("../../../../src/config/sessions/session-accessor.js").loadSessionEntry;
  resolveSessionTranscriptDatabasePath: typeof import("../../../../src/config/sessions/session-accessor.js").resolveSessionTranscriptDatabasePath;
};
type GatewayState = Pick<QaGatewayChild, "cfg" | "runtimeEnv" | "workspaceDir" | "tempRoot">;
type CompactionProofMessage = AgentMessage & { timestamp: number };

const TOOL_TEXT = "fixture output ".repeat(12_000);

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function targetFor(runtime: StateRuntime, gateway: GatewayState, proof: ProofCase) {
  const target = {
    agentId: "qa",
    sessionId: proof.sessionId,
    sessionKey: proof.sessionKey,
    env: gateway.runtimeEnv,
    storePath: runtime.store.resolveStorePath(undefined, {
      agentId: "qa",
      env: gateway.runtimeEnv,
    }),
  };
  const databasePath = runtime.resolveSessionTranscriptDatabasePath(target);
  assert.ok(
    databasePath.startsWith(`${path.join(gateway.tempRoot, "state")}${path.sep}`),
    "Compaction proof database escaped the owned Gateway state directory",
  );
  return target;
}

export function readCompactionEntry(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
) {
  const entry = runtime.loadSessionEntry({
    ...targetFor(runtime, gateway, proof),
    readConsistency: "latest",
  });
  assert.equal(entry?.sessionId, proof.sessionId, "Canonical session identity changed");
  assert.ok(entry, "Canonical session row disappeared");
  return structuredClone(entry);
}

export function adoptCompactionSessionIdentity(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
) {
  const entry = runtime.loadSessionEntry({
    agentId: "qa",
    sessionKey: proof.sessionKey,
    env: gateway.runtimeEnv,
    storePath: runtime.store.resolveStorePath(undefined, {
      agentId: "qa",
      env: gateway.runtimeEnv,
    }),
    readConsistency: "latest",
  });
  assert.ok(entry?.sessionId, "Setup turn did not create a canonical session row");
  proof.sessionId = entry.sessionId;
  return structuredClone(entry);
}

export async function waitForCompactionRunSettlement(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
  runId: string,
) {
  const deadline = Date.now() + CHECKPOINT_TIMEOUT_MS;
  for (;;) {
    const entry = readCompactionEntry(runtime, gateway, proof);
    if (entry.lifecycleRunId === undefined && entry.lastRunId === runId) {
      return entry;
    }
    assert.ok(Date.now() < deadline, "Original run's terminal lifecycle did not persist");
    await pollDelay(50);
  }
}

export function assertReplacementWriterPreserved(
  before: ReturnType<typeof readCompactionEntry>,
  after: ReturnType<typeof readCompactionEntry>,
  terminal: Record<string, unknown>,
  runId: string,
) {
  // Lifecycle ownership is independent of the transcript writer. Its exact run
  // may still publish terminal status, but cannot change compaction or accounting.
  assert.equal(before.status, "running");
  assert.equal(before.lifecycleRunId, runId);
  assert.equal(terminal.runId, runId);
  assert.equal(terminal.status, "error");
  assert.equal(after.status, "failed");
  assert.equal(after.lifecycleRunId, undefined);
  assert.equal(after.lastRunId, runId);
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.abortedLastRun, false);
  assert.ok(typeof before.startedAt === "number" && Number.isFinite(before.startedAt));
  assert.ok(typeof after.endedAt === "number" && Number.isFinite(after.endedAt));
  assert.ok(after.endedAt >= before.startedAt && after.endedAt <= Date.now());
  assert.equal(after.runtimeMs, after.endedAt - before.startedAt);
  // The entry merge stamps persistence time, which can be later than lifecycle end.
  assert.ok(Number.isFinite(after.updatedAt));
  assert.ok(after.updatedAt >= before.updatedAt && after.updatedAt >= after.endedAt);
  assert.ok(after.updatedAt <= Date.now());
  assert.ok(typeof terminal.error === "string" && terminal.error.trim().length > 0);
  assert.ok(typeof after.lastRunError === "string" && after.lastRunError.length > 0);
  assert.ok(after.lastRunError.length <= 160);
  assert.equal(after.lastRunError, after.lastRunError.replace(/\s+/g, " ").trim());
  const expected = {
    ...before,
    status: "failed" as const,
    endedAt: after.endedAt,
    runtimeMs: after.endedAt - before.startedAt,
    abortedLastRun: false,
    lastRunId: runId,
    lastRunError: after.lastRunError,
    updatedAt: after.updatedAt,
  };
  delete expected.lifecycleRunId;
  assert.deepEqual(after, expected, "Terminal lifecycle changed non-lifecycle writer state");
}

export async function waitForCompactionReply(
  state: Pick<QaBusState, "getSnapshot" | "waitForCursorAdvance">,
  runId: string,
  marker: string,
) {
  const repliesForRun = (snapshot: ReturnType<QaBusState["getSnapshot"]>) =>
    snapshot.messages.filter(
      (message) =>
        message.direction === "outbound" &&
        !message.deleted &&
        message.accountId === "default" &&
        message.conversation.id === "qa-operator" &&
        message.conversation.kind === "direct" &&
        message.replyToId === runId,
    );
  const hasMarker = (snapshot: ReturnType<QaBusState["getSnapshot"]>) =>
    repliesForRun(snapshot).some((message) => message.text === marker);
  const before = state.getSnapshot();
  // The transport's default waiter rejects any historical account-level error.
  // This proof deliberately fails an earlier turn; observe only this exact run.
  if (!hasMarker(before)) {
    await state.waitForCursorAdvance(before.cursor, CHECKPOINT_TIMEOUT_MS, hasMarker);
  }
  const replies = repliesForRun(state.getSnapshot());
  assert.deepEqual(
    replies.map((message) => message.text),
    [marker],
    "Run did not deliver one exact reply",
  );
  assert.notEqual(replies[0]?.isError, true, "Expected reply was delivered as an error");
}

export async function waitForHeldCompactionAccounting(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
) {
  const deadline = Date.now() + CHECKPOINT_TIMEOUT_MS;
  for (;;) {
    assert.ok(proof.afterHookPending, "After hook stopped waiting before bookkeeping settled");
    const entry = readCompactionEntry(runtime, gateway, proof);
    if (entry.compactionCount === 1) {
      return entry;
    }
    assert.ok(
      Date.now() < deadline,
      "Aborted run did not settle compaction count one while the after hook remained held",
    );
    await pollDelay(50);
  }
}

export async function replaceCompactionWriter(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
  runId: string,
) {
  const before = readCompactionEntry(runtime, gateway, proof);
  assert.equal(before.activeWriterRunId, runId, "Held run did not own the canonical writer");
  const target = targetFor(runtime, gateway, proof);
  const replacementRunId = randomUUID();
  // This child cannot signal the Gateway's process-local run registry. The real
  // claim therefore challenges the storage fence independently of chat.abort.
  const claim = await runtime.claimAgentSessionWriter({
    sessionId: proof.sessionId,
    sessionKey: proof.sessionKey,
    sessionTarget: target,
    agentId: target.agentId,
    workspaceDir: gateway.workspaceDir,
    config: gateway.cfg,
    runId: replacementRunId,
    prompt: "QA replacement writer",
    timeoutMs: CHECKPOINT_TIMEOUT_MS,
  });
  assert.ok(claim, "Replacement did not claim the existing session row");
  assert.equal(claim.expectedWriterRunId, replacementRunId);
  assert.equal(claim.expectedLifecycleRevision, before.lifecycleRevision);
  const after = readCompactionEntry(runtime, gateway, proof);
  assert.equal(after.activeWriterRunId, replacementRunId, "Replacement writer was not durable");
  assert.equal(after.lifecycleRevision, before.lifecycleRevision, "Writer claim rotated lifecycle");
  recordCompactionProofCheckpoint(proof, "writer-replaced", { runId, replacementRunId });
  return after;
}

export async function seedCompactionTranscript(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
  options: { preserveSessionEntry?: boolean } = {},
) {
  const target = targetFor(runtime, gateway, proof);
  const now = Date.now();
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (text: string, timestamp: number): CompactionProofMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "mock-openai",
    model: MODEL_ID,
    usage,
    stopReason: "stop",
    timestamp,
  });
  const messages: CompactionProofMessage[] = [];
  // Enough older turns to summarize, with headroom for the current prompt.
  // The provider injects overflow; fixture size must not trigger local preflight.
  for (let index = 0; index < 4; index += 1) {
    messages.push(
      {
        role: "user",
        content: `Historical user block ${index} ${"u".repeat(4096)}`,
        timestamp: now - 50_000 + index * 2_000,
      },
      assistant(
        `Historical assistant block ${index} ${"r".repeat(4096)}`,
        now - 49_000 + index * 2_000,
      ),
    );
  }
  // A text-only history cannot expose the post-abort truncation defect. Keep
  // the completed call/result pair in the active suffix, beyond summary history.
  messages.push(
    {
      role: "user",
      content: "Read the retained fixture before continuing.",
      timestamp: now - 3_000,
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: TOOL_CALL_ID, name: "read", arguments: { path: "fixture.txt" } },
      ],
      api: "openai-responses",
      provider: "mock-openai",
      model: MODEL_ID,
      usage,
      stopReason: "toolUse",
      timestamp: now - 2_000,
    },
    {
      role: "toolResult",
      toolCallId: TOOL_CALL_ID,
      toolName: "read",
      content: [{ type: "text", text: TOOL_TEXT }],
      isError: false,
      timestamp: now - 1_000,
    },
  );
  const current = options.preserveSessionEntry
    ? runtime.loadSessionEntry({ ...target, readConsistency: "latest" })
    : undefined;
  await runtime.store.upsertSessionEntry({
    ...target,
    entry: {
      ...current,
      sessionId: proof.sessionId,
      updatedAt: now,
      compactionCount: current?.compactionCount ?? 0,
    },
  });
  for (const message of messages) {
    const result = await runtime.transcript.appendSessionTranscriptMessageByIdentity({
      ...target,
      message,
      now: message.timestamp,
    });
    assert.ok(result?.appended, "Could not persist a fixture transcript message");
  }
}

export async function patchCompactionSessionOwnership(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
  patch: { agentRuntimeOverride: string; agentHarnessId: string },
) {
  const current = readCompactionEntry(runtime, gateway, proof);
  await runtime.store.upsertSessionEntry({
    ...targetFor(runtime, gateway, proof),
    entry: { ...current, ...patch, updatedAt: Date.now() },
  });
  const updated = readCompactionEntry(runtime, gateway, proof);
  assert.equal(updated.agentRuntimeOverride, patch.agentRuntimeOverride);
  assert.equal(updated.agentHarnessId, patch.agentHarnessId);
  return updated;
}

export function snapshotCompactionSession(
  runtime: StateRuntime,
  gateway: GatewayState,
  proof: ProofCase,
) {
  const target = targetFor(runtime, gateway, proof);
  const entry = readCompactionEntry(runtime, gateway, proof);
  const manager = runtime.sessions.SessionManager.open(target, gateway.workspaceDir);
  const branch = manager.getBranch();
  const toolEntries = branch.filter(
    (event) =>
      event.type === "message" &&
      event.message.role === "toolResult" &&
      event.message.toolCallId === TOOL_CALL_ID,
  );
  return {
    events: runtime.store.loadTranscriptEventsSync(target),
    sessionId: entry.sessionId,
    leafId: manager.getLeafId(),
    activeEntryIds: branch.map((event) => event.id),
    activeTool: toolEntries,
    toolChars: toolEntries.reduce(
      (total, event) =>
        total +
        (event.type === "message" && event.message.role === "toolResult"
          ? event.message.content.reduce(
              (chars, block) => chars + (block.type === "text" ? block.text.length : 0),
              0,
            )
          : 0),
      0,
    ),
    compactionIds: manager
      .getEntries()
      .filter((event) => event.type === "compaction")
      .map((event) => event.id),
    compactionCount: entry.compactionCount ?? 0,
    compactionCheckpoints: entry.compactionCheckpoints,
    transcriptByteCompactionLatch: entry.transcriptByteCompactionLatch,
    agentRuntimeOverride: entry.agentRuntimeOverride,
    agentHarnessId: entry.agentHarnessId,
    activeWriterRunId: entry.activeWriterRunId,
    lifecycleRevision: entry.lifecycleRevision,
  };
}

export type CompactionProofSnapshot = ReturnType<typeof snapshotCompactionSession>;

export function assertOriginalCompactionRows(
  before: CompactionProofSnapshot,
  after: CompactionProofSnapshot,
) {
  assert.equal(
    digest(after.events.slice(0, before.events.length)),
    digest(before.events),
    "Pre-existing durable transcript rows changed",
  );
}

export function assertUncommittedCompactionHistory(
  before: CompactionProofSnapshot,
  after: CompactionProofSnapshot,
) {
  assertOriginalCompactionRows(before, after);
  const originalIds = new Set(before.activeEntryIds);
  assert.deepEqual(
    after.activeEntryIds.filter((id) => originalIds.has(id)),
    before.activeEntryIds,
    "Interrupted recovery replaced the retained active branch",
  );
  assert.equal(
    digest(after.activeTool),
    digest(before.activeTool),
    `Interrupted recovery changed active tool content (${before.toolChars} -> ${after.toolChars} chars)`,
  );
  assert.deepEqual(
    after.compactionIds,
    before.compactionIds,
    "Interrupted recovery committed a compaction",
  );
  assert.equal(
    after.compactionCount,
    before.compactionCount,
    "Interrupted recovery changed compaction accounting",
  );
  assert.deepEqual(
    after.compactionCheckpoints,
    before.compactionCheckpoints,
    "Interrupted recovery changed compaction checkpoints",
  );
  assert.deepEqual(
    after.transcriptByteCompactionLatch,
    before.transcriptByteCompactionLatch,
    "Interrupted recovery changed the transcript byte latch",
  );
}

export function assertResetWithoutCompaction(
  before: CompactionProofSnapshot,
  after: CompactionProofSnapshot,
  options: { allowSuccessorEvents?: boolean } = {},
) {
  assertOriginalCompactionRows(before, after);
  const appended = after.events.slice(before.events.length);
  const resetEvents = appended.filter(
    (event) =>
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type === "reset",
  );
  assert.equal(resetEvents.length, 1, "Reset did not append exactly one transcript boundary");
  assert.equal(
    (resetEvents[0] as { reason?: unknown }).reason,
    "reset",
    "Reset transcript boundary reason changed",
  );
  assert.equal(
    appended.some(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as { type?: unknown }).type === "compaction",
    ),
    false,
    "Revoked heartbeat appended a compaction event",
  );
  if (!options.allowSuccessorEvents) {
    assert.equal(appended.length, 1, "Reset terminal transcript contains unexpected writes");
  }
  assert.deepEqual(
    after.compactionIds,
    before.compactionIds,
    "Revoked heartbeat committed a compaction",
  );
  assert.equal(
    after.compactionCount,
    before.compactionCount,
    "Revoked heartbeat changed compaction accounting",
  );
  assert.deepEqual(
    after.compactionCheckpoints,
    before.compactionCheckpoints,
    "Revoked heartbeat changed compaction checkpoints",
  );
  assert.deepEqual(
    after.transcriptByteCompactionLatch,
    before.transcriptByteCompactionLatch,
    "Revoked heartbeat changed the transcript byte latch",
  );
}

export function assertCommittedCompactionHistory(
  committed: CompactionProofSnapshot,
  after: CompactionProofSnapshot,
) {
  assertOriginalCompactionRows(committed, after);
  assert.deepEqual(
    after.compactionIds,
    committed.compactionIds,
    "Late stop lost or repeated compaction",
  );
  assert.equal(after.compactionCount, 1, "Late stop lost completed compaction accounting");
  assert.deepEqual(
    after.compactionCheckpoints,
    committed.compactionCheckpoints,
    "Late stop changed the committed compaction checkpoints",
  );
  for (const id of committed.compactionIds) {
    assert.ok(
      after.activeEntryIds.includes(id),
      "Late stop removed the committed active compaction",
    );
  }
}
