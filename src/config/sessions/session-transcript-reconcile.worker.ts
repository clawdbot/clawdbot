/** Worker entrypoint for transcript parsing and active-branch resolution only. */
import { parentPort, workerData } from "node:worker_threads";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../../state/openclaw-agent-db-lease.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import {
  prepareSessionTranscriptProjection,
  prepareMemorySessionTranscriptProjection,
  type SessionTranscriptProjectionRow,
  type PreparedSessionTranscriptProjection,
  type PreparedSessionTranscriptProjectionMetadata,
  type TranscriptIndexEntry,
} from "./session-transcript-projection-rebuild.js";
import type { MemoryTranscriptProjectionFrame } from "./session-transcript-reconcile-memory.js";

const ACTIVE_ROWS_PER_CHUNK = 512;
const FTS_ROWS_PER_CHUNK = 128;
const FTS_TEXT_BYTES_PER_CHUNK = 256 * 1024;

type ReconcileWorkerOwner = {
  stateDir: string;
  externallySupervised: boolean;
};

type ReconcileWorkerPlanInput = ReconcileWorkerOwner & {
  agentId: string;
  path: string;
  preferredSessionId?: string;
};

export type SessionTranscriptReconcileWorkerInput =
  | (ReconcileWorkerPlanInput & { mode: "disk"; leaseId: string })
  | { mode: "memory"; sessionIds: string[] }
  | (ReconcileWorkerOwner & { mode: "release"; leaseId: string });

export type EncodedTranscriptFtsChunk = {
  rows: Array<{
    messageId: string;
    role: "assistant" | "user";
    textByteLength: number;
    textByteOffset: number;
    timestamp: number;
  }>;
  textBytes: Uint8Array<ArrayBuffer>;
};

export type SessionTranscriptReconcileWorkerMessage =
  | {
      type: "active-chunk";
      rows: PreparedSessionTranscriptProjection["activeRows"];
      sessionId: string;
    }
  | { type: "done" }
  | { type: "failed"; error: string }
  | { type: "lease-released" }
  | { type: "lease-release-failed"; error: string }
  | { type: "fts-chunk"; chunk: EncodedTranscriptFtsChunk; sessionId: string }
  | { type: "plan-finish"; sessionId: string }
  | { type: "plan-start"; plan: PreparedSessionTranscriptProjectionMetadata }
  | { type: "source-read"; sessionId: string };

type SessionTranscriptReconcileWorkerCommand = { accepted: boolean; type: "continue" };

function parseWorkerInput(value: unknown): SessionTranscriptReconcileWorkerInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (
    input.mode === "memory" &&
    Array.isArray(input.sessionIds) &&
    input.sessionIds.every((sessionId) => typeof sessionId === "string")
  ) {
    return { mode: "memory", sessionIds: input.sessionIds };
  }
  if (typeof input.stateDir !== "string" || typeof input.externallySupervised !== "boolean") {
    return undefined;
  }
  const owner = { stateDir: input.stateDir, externallySupervised: input.externallySupervised };
  if (input.mode === "release" && typeof input.leaseId === "string") {
    return { ...owner, mode: "release", leaseId: input.leaseId };
  }
  if (typeof input.agentId !== "string" || typeof input.path !== "string") {
    return undefined;
  }
  if (input.preferredSessionId !== undefined && typeof input.preferredSessionId !== "string") {
    return undefined;
  }
  const plan = {
    ...owner,
    agentId: input.agentId,
    path: input.path,
    ...(typeof input.preferredSessionId === "string"
      ? { preferredSessionId: input.preferredSessionId }
      : {}),
  };
  if (input.mode === "disk" && typeof input.leaseId === "string") {
    return { ...plan, mode: "disk", leaseId: input.leaseId };
  }
  return undefined;
}

function orderSessionIds(sessionIds: string[], preferredSessionId: string | undefined): string[] {
  if (!preferredSessionId || !sessionIds.includes(preferredSessionId)) {
    return sessionIds;
  }
  return [
    preferredSessionId,
    ...sessionIds.filter((sessionId) => sessionId !== preferredSessionId),
  ];
}

const parsedInput = parseWorkerInput(workerData);
if (!parentPort || !parsedInput) {
  throw new Error("session transcript reconcile worker requires valid worker data");
}
const port = parentPort;
const input: SessionTranscriptReconcileWorkerInput = parsedInput;
function resolveLeaseEnvironment(owner: ReconcileWorkerOwner) {
  return {
    OPENCLAW_STATE_DIR: owner.stateDir,
    ...(owner.externallySupervised ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
}

function releaseLease(owner: ReconcileWorkerOwner & { leaseId: string }): void {
  try {
    releaseOpenClawAgentDatabaseLease(owner.leaseId, { env: resolveLeaseEnvironment(owner) });
    closeOpenClawStateDatabase();
    port.postMessage({ type: "lease-released" } satisfies SessionTranscriptReconcileWorkerMessage);
  } catch (error) {
    port.postMessage({
      type: "lease-release-failed",
      error: error instanceof Error ? error.message : String(error),
    } satisfies SessionTranscriptReconcileWorkerMessage);
  } finally {
    port.close();
  }
}

function waitForContinue(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    port.once("message", (message: SessionTranscriptReconcileWorkerCommand) => {
      if (message?.type !== "continue" || typeof message.accepted !== "boolean") {
        reject(new Error("session transcript reconcile worker received an invalid command"));
        return;
      }
      resolve(message.accepted);
    });
  });
}

async function postAndWait(
  message: SessionTranscriptReconcileWorkerMessage,
  transferList: ArrayBuffer[] = [],
): Promise<boolean> {
  port.postMessage(message, transferList);
  return await waitForContinue();
}

function encodeFtsChunk(rows: readonly TranscriptIndexEntry[]): EncodedTranscriptFtsChunk {
  const encoder = new TextEncoder();
  const encoded = rows.map((row) => ({ bytes: encoder.encode(row.text), row }));
  const textBytes = new Uint8Array(encoded.reduce((total, entry) => total + entry.bytes.length, 0));
  let textByteOffset = 0;
  const metadata = encoded.map(({ bytes, row }) => {
    textBytes.set(bytes, textByteOffset);
    const result = {
      messageId: row.messageId,
      role: row.role,
      textByteLength: bytes.length,
      textByteOffset,
      timestamp: row.timestamp,
    };
    textByteOffset += bytes.length;
    return result;
  });
  return { rows: metadata, textBytes };
}

function takeFtsChunkEnd(rows: readonly TranscriptIndexEntry[], start: number): number {
  let bytes = 0;
  let end = start;
  while (end < rows.length && end - start < FTS_ROWS_PER_CHUNK) {
    const rowBytes = Buffer.byteLength(rows[end]?.text ?? "", "utf8");
    if (end > start && bytes + rowBytes > FTS_TEXT_BYTES_PER_CHUNK) {
      break;
    }
    bytes += rowBytes;
    end += 1;
  }
  return end;
}

async function streamPreparedProjection(plan: PreparedSessionTranscriptProjection): Promise<void> {
  const { activeRows, ftsRows, ...metadata } = plan;
  if (!(await postAndWait({ type: "plan-start", plan: metadata }))) {
    return;
  }
  for (let offset = 0; offset < activeRows.length; offset += ACTIVE_ROWS_PER_CHUNK) {
    if (
      !(await postAndWait({
        type: "active-chunk",
        rows: activeRows.slice(offset, offset + ACTIVE_ROWS_PER_CHUNK),
        sessionId: plan.sessionId,
      }))
    ) {
      return;
    }
  }
  for (let offset = 0; offset < ftsRows.length;) {
    const end = takeFtsChunkEnd(ftsRows, offset);
    const chunk = encodeFtsChunk(ftsRows.slice(offset, end));
    const accepted = await postAndWait({ type: "fts-chunk", chunk, sessionId: plan.sessionId }, [
      chunk.textBytes.buffer,
    ]);
    if (!accepted) {
      return;
    }
    offset = end;
  }
  await postAndWait({ type: "plan-finish", sessionId: plan.sessionId });
}

async function prepareMemoryProjection(sessionId: string) {
  const rows = new Map<number, SessionTranscriptProjectionRow>();
  const decoder = new TextDecoder();
  let fragments: string[] = [];
  while (true) {
    const pending = new Promise<MemoryTranscriptProjectionFrame>((resolve) => {
      port.once("message", resolve);
    });
    port.postMessage({
      type: "source-read",
      sessionId,
    } satisfies SessionTranscriptReconcileWorkerMessage);
    const frame = await pending;
    if (frame.type === "source-unavailable") {
      return undefined;
    }
    if (frame.type === "source-end") {
      const plan = prepareMemorySessionTranscriptProjection(
        sessionId,
        frame.snapshot.transcriptUpdatedAt,
        rows,
      );
      rows.clear();
      return plan;
    }
    fragments.push(decoder.decode(frame.bytes, { stream: !frame.final }));
    if (frame.final) {
      rows.set(frame.seq, {
        seq: frame.seq,
        created_at: frame.createdAt,
        event_json: fragments.join(""),
      });
      fragments = [];
    }
  }
}

async function run(): Promise<void> {
  if (input.mode === "release") {
    releaseLease(input);
    return;
  }
  const reconcileInput = input;
  let closeDatabase: (() => void) | undefined;
  let terminalMessage: Extract<
    SessionTranscriptReconcileWorkerMessage,
    { type: "done" | "failed" }
  >;
  try {
    const database = (() => {
      if (reconcileInput.mode === "memory") {
        return undefined;
      }
      const options = {
        agentId: reconcileInput.agentId,
        path: reconcileInput.path,
        env: resolveLeaseEnvironment(reconcileInput),
      };
      // The parent knows this identity before admission, even if native exit prevents a reply.
      claimOpenClawAgentDatabaseLease(options, reconcileInput.leaseId);
      const opened = openOpenClawAgentDatabaseReadOnly(options);
      if (!opened.found) {
        throw new Error(`Cannot prepare transcript indexes: ${opened.reason}`);
      }
      closeDatabase = opened.database.close;
      return opened.database;
    })();
    const sessionIds =
      reconcileInput.mode === "memory"
        ? reconcileInput.sessionIds
        : orderSessionIds(
            listSessionsNeedingTranscriptIndexReconcile(database!.db),
            reconcileInput.preferredSessionId,
          );
    for (const sessionId of sessionIds) {
      const plan =
        reconcileInput.mode === "memory"
          ? await prepareMemoryProjection(sessionId)
          : prepareSessionTranscriptProjection(database!.db, sessionId);
      if (plan) {
        await streamPreparedProjection(plan);
      }
    }
    terminalMessage = { type: "done" };
  } catch (error) {
    terminalMessage = {
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    closeDatabase?.();
    port.postMessage(terminalMessage);
    if (reconcileInput.mode === "disk") {
      // The final parent write must finish before this independent deletion fence is released.
      port.once("message", (message: { type?: unknown }) => {
        if (message?.type !== "release") {
          throw new Error("session transcript reconcile worker expected lease release");
        }
        releaseLease(reconcileInput);
      });
    }
  } finally {
    if (reconcileInput.mode === "memory") {
      port.close();
    }
  }
}

void run();
