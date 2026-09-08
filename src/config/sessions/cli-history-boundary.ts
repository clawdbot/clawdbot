import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";

export type CliHistoryWriter = {
  target: SessionTranscriptRuntimeTarget;
  runId: string;
  authFingerprint: string;
  lifecycleRevision?: string;
  expectedWriterRunId?: string;
  assertCurrent: () => void;
  assertReadable: () => void;
};

const cliHistoryWriter = new AsyncLocalStorage<CliHistoryWriter>();

export function runWithCliHistoryWriter<T>(writer: CliHistoryWriter | undefined, run: () => T): T {
  return writer ? cliHistoryWriter.run(writer, run) : cliHistoryWriter.exit(run);
}

export function getCliHistoryWriter(
  target: SessionTranscriptRuntimeTarget,
): CliHistoryWriter | undefined {
  const writer = cliHistoryWriter.getStore();
  return writer &&
    writer.target.agentId === target.agentId &&
    writer.target.sessionId === target.sessionId &&
    writer.target.sessionKey === target.sessionKey &&
    writer.target.storePath === target.storePath
    ? writer
    : undefined;
}

/** Private proof of the account that owns every covered transcript event. */
export type CliHistoryBoundary =
  | { version: 1; sessionId: string; state: "unknown" }
  | {
      version: 1;
      sessionId: string;
      state: "known";
      authFingerprint: string;
      generation: string | null;
      maxSeq: number | null;
      writerRunId: string;
    };

export function isKnownCliHistoryBoundary(
  boundary: CliHistoryBoundary | undefined,
): boundary is Extract<CliHistoryBoundary, { state: "known" }> {
  return (
    boundary?.version === 1 &&
    boundary.state === "known" &&
    typeof boundary.sessionId === "string" &&
    boundary.sessionId.length > 0 &&
    typeof boundary.authFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(boundary.authFingerprint) &&
    (boundary.generation === null ||
      (typeof boundary.generation === "string" && boundary.generation.length > 0)) &&
    (boundary.maxSeq === null ||
      (boundary.generation !== null &&
        Number.isSafeInteger(boundary.maxSeq) &&
        boundary.maxSeq >= 0)) &&
    typeof boundary.writerRunId === "string" &&
    boundary.writerRunId.length > 0
  );
}
