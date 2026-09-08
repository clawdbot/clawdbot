import { isDeepStrictEqual } from "node:util";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionEntry,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  resolveSessionTranscriptDatabasePath,
  rewriteTranscriptMessageAtAnchor,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { sessionMatchesExpectedTranscriptTurn } from "../config/sessions/session-transcript-turn-state.js";
import { getOwnedSessionTranscriptWriterFence } from "../config/sessions/transcript-write-context.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import type {
  UserTurnTranscriptAnnotation,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

/** Core-only binding performed by the harness host before invoking plugin code. */
export function bindUserTurnTranscriptAnnotation(params: {
  recorder: UserTurnTranscriptRecorder;
  target: SessionTranscriptRuntimeTarget & {
    expectedLifecycleRevision?: string;
    expectedWriterRunId?: string;
  };
  runId: string;
  config?: OpenClawConfig;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
}): ((annotation: UserTurnTranscriptAnnotation) => Promise<void>) | undefined {
  const owner = getUserTurnTranscriptAdmissionOwner(params.recorder);
  const receipt = owner?.receipt();
  const message = owner?.message();
  if (!owner || !receipt || !message || owner.blocked() || message.display === false) {
    return undefined;
  }
  let admission = structuredClone(receipt);
  let admittedMessage = structuredClone(message);
  const target = { ...params.target };
  const selected = loadSessionEntry({ ...target, readConsistency: "latest" });
  const fence = getOwnedSessionTranscriptWriterFence({ sessionTarget: target });
  if (
    target.sessionId !== admission.sessionId ||
    target.sessionKey !== admission.sessionKey ||
    target.agentId !== admission.agentId ||
    resolveSessionTranscriptDatabasePath(target) !== admission.storePath ||
    !selected ||
    selected.sessionId !== admission.sessionId ||
    (selected.activeWriterRunId !== undefined && selected.activeWriterRunId !== params.runId)
  ) {
    return undefined;
  }
  const expectedLifecycleRevision =
    target.expectedLifecycleRevision ??
    fence?.expectedLifecycleRevision ??
    selected.lifecycleRevision ??
    null;
  const expectedWriterRunId = target.expectedWriterRunId ?? fence?.expectedWriterRunId;
  const assertCurrent = () => {
    params.assertCurrent();
    const current = loadSessionEntry({ ...target, readConsistency: "latest" });
    const { logicalTurnId: _logicalTurnId, role: _role, ...anchor } = admission;
    if (
      params.abortSignal?.aborted ||
      owner.blocked() ||
      !isDeepStrictEqual(owner.receipt(), admission) ||
      !isDeepStrictEqual(owner.message(), admittedMessage) ||
      admittedMessage["__openclaw"]?.steerTargetRunId !== undefined ||
      !sessionMatchesExpectedTranscriptTurn(current ? { entry: current } : undefined, {
        expectedSessionId: admission.sessionId,
        expectedLifecycleRevision,
        expectedWriterRunId,
      }) ||
      (fence?.expectedWriterRunId !== undefined &&
        current?.activeWriterRunId !== fence.expectedWriterRunId) ||
      (fence?.expectedLifecycleRevision !== undefined &&
        current?.lifecycleRevision !== fence.expectedLifecycleRevision) ||
      current?.activeWriterRunId !== selected.activeWriterRunId ||
      sessionTranscriptIndexNeedsReconcile(
        openOpenClawAgentDatabase({ agentId: admission.agentId, path: admission.storePath }).db,
        admission.sessionId,
      ) ||
      !isDeepStrictEqual(readActiveTranscriptEntryAnchor(admission), anchor)
    ) {
      throw new Error("current user admission is no longer available for native annotation");
    }
  };
  return async (annotation) => {
    // Copy only the closed provenance tuple before any await. The host fixes the diagnostic run ID.
    const fields = {
      mirrorIdentity: annotation.mirrorIdentity,
      upstreamUserText: annotation.upstreamUserText,
      mirrorOrigin: annotation.mirrorOrigin,
      mirrorSourceFingerprint: annotation.mirrorSourceFingerprint,
      runId: params.runId,
    };
    if (
      Object.values(fields).some((value) => typeof value !== "string") ||
      !fields.mirrorIdentity ||
      !fields.mirrorOrigin ||
      !fields.mirrorSourceFingerprint
    ) {
      throw new Error("native prompt annotation requires complete provenance");
    }
    assertCurrent();
    // This is the existing user-source fingerprint contract, including upstream prompt bytes.
    const fingerprint = sha256HexPrefixCore(
      JSON.stringify({
        role: "user",
        content: admittedMessage.content,
        upstreamUserText: fields.upstreamUserText || undefined,
      }),
      32,
    );
    if (fingerprint !== fields.mirrorSourceFingerprint) {
      throw new Error("native prompt annotation does not match admitted content");
    }
    let verified = false;
    const rewritten = await rewriteTranscriptMessageAtAnchor(admission, (current) => {
      // Revalidate after writer acquisition, inside the synchronous commit transaction.
      assertCurrent();
      if (!isDeepStrictEqual(current, admittedMessage)) {
        throw new Error("native prompt annotation cannot replace an edited admission");
      }
      const metadata = admittedMessage["__openclaw"] ?? {};
      if (
        metadata.runTerminal !== undefined ||
        Object.entries(fields).some(
          ([key, value]) => metadata[key] !== undefined && metadata[key] !== value,
        )
      ) {
        throw new Error("native prompt annotation conflicts with recorded provenance");
      }
      const next = { ...admittedMessage, __openclaw: { ...metadata, ...fields } };
      if (!isDeepStrictEqual(redactTranscriptMessage(next, params.config), next)) {
        throw new Error("native prompt annotation would restore redacted evidence");
      }
      verified = true;
      return isDeepStrictEqual(next, admittedMessage) ? undefined : next;
    });
    if (!verified) {
      throw new Error("native prompt admission disappeared before annotation");
    }
    if (rewritten) {
      admission = { ...admission, generation: rewritten.generation };
      // Recorder getters and update listeners must never expose the private validation snapshot.
      admittedMessage = structuredClone(rewritten.message);
      owner.refresh({ ...admission }, rewritten.message);
      await waitForSessionTranscriptProjection(admission, params.abortSignal);
    }
    assertCurrent();
    if (rewritten) {
      await publishTranscriptUpdate(admission, {
        message: rewritten.message,
        messageId: admission.entryId,
        messageSeq: admission.activeMessagePosition + 1,
      });
      assertCurrent();
    }
  };
}
