/** Worker entrypoint for transcript parsing and active-branch resolution only. */
import { parentPort, workerData } from "node:worker_threads";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import {
  prepareSessionTranscriptProjection,
  type PreparedSessionTranscriptProjection,
  type PreparedSessionTranscriptProjectionMetadata,
  type TranscriptIndexEntry,
} from "./session-transcript-projection-rebuild.js";

const ACTIVE_ROWS_PER_CHUNK = 512;
const FTS_ROWS_PER_CHUNK = 128;
const FTS_TEXT_BYTES_PER_CHUNK = 256 * 1024;

export type SessionTranscriptReconcileWorkerInput = {
  agentId: string;
  path: string;
  preferredSessionId?: string;
};

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
  | { type: "fts-chunk"; chunk: EncodedTranscriptFtsChunk; sessionId: string }
  | { type: "plan-finish"; sessionId: string }
  | { type: "plan-start"; plan: PreparedSessionTranscriptProjectionMetadata };

type SessionTranscriptReconcileWorkerCommand = { accepted: boolean; type: "continue" };

function parseWorkerInput(value: unknown): SessionTranscriptReconcileWorkerInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (typeof input.agentId !== "string" || typeof input.path !== "string") {
    return undefined;
  }
  if (input.preferredSessionId !== undefined && typeof input.preferredSessionId !== "string") {
    return undefined;
  }
  return {
    agentId: input.agentId,
    path: input.path,
    ...(typeof input.preferredSessionId === "string"
      ? { preferredSessionId: input.preferredSessionId }
      : {}),
  };
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

const input = parseWorkerInput(workerData);
if (!parentPort || !input) {
  throw new Error("session transcript reconcile worker requires valid worker data");
}
const port = parentPort;
const reconcileInput: SessionTranscriptReconcileWorkerInput = input;

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

async function run(): Promise<void> {
  try {
    const database = openOpenClawAgentDatabase({
      agentId: reconcileInput.agentId,
      path: reconcileInput.path,
    });
    const sessionIds = orderSessionIds(
      listSessionsNeedingTranscriptIndexReconcile(database.db),
      reconcileInput.preferredSessionId,
    );
    for (const sessionId of sessionIds) {
      const plan = prepareSessionTranscriptProjection(database.db, sessionId);
      if (plan) {
        await streamPreparedProjection(plan);
      }
    }
    port.postMessage({ type: "done" } satisfies SessionTranscriptReconcileWorkerMessage);
  } catch (error) {
    port.postMessage({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    } satisfies SessionTranscriptReconcileWorkerMessage);
  } finally {
    closeOpenClawAgentDatabaseByPath(reconcileInput.path);
    port.close();
  }
}

void run();
