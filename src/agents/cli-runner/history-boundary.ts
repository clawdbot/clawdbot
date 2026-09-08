import { createHash } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  isKnownCliHistoryBoundary,
  type CliHistoryBoundary,
  type CliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  readSessionTranscriptWatermark,
  resolveSessionTranscriptDatabasePath,
  validateSessionTranscriptContextAdmission,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { assertOwnedTranscriptWriteCommit } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { buildSessionContext, SessionManager } from "../sessions/session-manager.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

/**
 * History belongs to the local transcript, not the latest native handle. Cover only
 * a proven-empty start or the contiguous events of the previously admitted CLI run.
 * An account transition, old-runtime write, import or unknown legacy prefix stays
 * unknown until an explicitly empty context starts a new history boundary.
 */
export async function prepareCliHistoryBoundary(
  params: PreparedCliRunContext["params"],
  identity: { credential?: AuthProfileCredential },
): Promise<CliHistoryWriter | undefined> {
  const source = params.sessionTarget;
  if (
    params.sessionManager ||
    !source ||
    source.sessionId !== params.sessionId ||
    (params.sessionKey !== undefined && params.sessionKey !== source.sessionKey) ||
    !resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
  ) {
    return undefined;
  }
  const target = { ...source, storePath: resolveSessionTranscriptDatabasePath(source) };
  const assertCurrent = createCliRunCurrentAssertion(params);
  await waitForSessionTranscriptProjection(target);
  assertCurrent();
  const snapshot: InternalSessionEntry | undefined = loadSessionEntryReadOnly(target);
  if (!snapshot || snapshot.sessionId !== target.sessionId) {
    return undefined;
  }
  const watermark = readSessionTranscriptWatermark(target);
  const admission = resolveSessionTranscriptReadFence(target);
  validateSessionTranscriptContextAdmission(target, admission);
  const priorMaxSeq = admission ? admission.rawSeq - 1 : watermark.maxSeq;
  const currentUserIsLast = !admission || watermark.maxSeq === admission.rawSeq;
  const stored = snapshot.cliHistoryBoundary;
  const credential = identity.credential;
  // Native reuse epochs intentionally tolerate identity-less OAuth and stable
  // SecretRefs. History cannot: use the resolved static credential or a named
  // OAuth account, never a profile name, reference, or opaque CLI login alone.
  const owner =
    credential?.type === "oauth"
      ? credential.accountId?.trim() || credential.email?.trim()
        ? [
            "oauth",
            credential.provider,
            credential.accountId,
            credential.email,
            credential.clientId,
            credential.enterpriseUrl,
            credential.projectId,
          ]
        : undefined
      : credential?.type === "api_key" && credential.key?.trim()
        ? ["api_key", credential.provider, credential.key]
        : credential?.type === "token" && credential.token?.trim()
          ? ["token", credential.provider, credential.token]
          : undefined;
  const fingerprint = owner
    ? createHash("sha256")
        .update(JSON.stringify(["cli-history-v1", normalizeProviderId(params.provider), owner]))
        .digest("hex")
    : undefined;
  const writerRunId = params.expectedWriterRunId ?? params.runId;
  let allowed = Boolean(
    fingerprint &&
    currentUserIsLast &&
    params.cliSessionBinding?.forceReuse !== true &&
    isKnownCliHistoryBoundary(stored) &&
    stored.sessionId === target.sessionId &&
    stored.authFingerprint === fingerprint &&
    stored.generation === watermark.generation &&
    (stored.maxSeq === priorMaxSeq ||
      (admission && stored.writerRunId === writerRunId && stored.maxSeq === watermark.maxSeq)),
  );
  if (
    !allowed &&
    fingerprint &&
    currentUserIsLast &&
    !params.cliSessionId &&
    !params.cliSessionBinding
  ) {
    let truncated = false;
    const branch = SessionManager.openBounded(target, {
      maxBytes: 1024 * 1024,
      maxEvents: 100,
      onTruncated: () => {
        truncated = true;
      },
    }).getBranch();
    // Bookkeeping is not a conversation. Retained reset rows, summaries, custom
    // context, missing anchors and bounded cuts must never look like a fresh start.
    allowed = !truncated && buildSessionContext(branch).messages.length === 0;
  }
  allowed &&= watermark.maxSeq === null || typeof watermark.generation === "string";
  if (!allowed && !stored) {
    return undefined;
  }
  const boundary: CliHistoryBoundary =
    allowed && fingerprint
      ? {
          version: 1,
          sessionId: target.sessionId,
          state: "known",
          authFingerprint: fingerprint,
          generation: watermark.generation,
          maxSeq: watermark.maxSeq,
          writerRunId,
        }
      : { version: 1, sessionId: target.sessionId, state: "unknown" };
  const committed = await patchSessionEntryCore(
    target,
    (current: InternalSessionEntry) => {
      if (
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== snapshot.lifecycleRevision ||
        current.activeWriterRunId !== snapshot.activeWriterRunId ||
        (current.activeWriterRunId !== undefined && current.activeWriterRunId !== writerRunId) ||
        (params.expectedLifecycleRevision !== undefined &&
          current.lifecycleRevision !== params.expectedLifecycleRevision)
      ) {
        throw new Error("CLI history owner changed before preparation");
      }
      const patch: Partial<InternalSessionEntry> = { cliHistoryBoundary: boundary };
      return patch;
    },
    {
      preserveActivity: true,
      skipMaintenance: true,
      assertCommitAllowed: () => {
        assertCurrent();
        assertOwnedTranscriptWriteCommit(target);
        validateSessionTranscriptContextAdmission(target, admission);
        const fresh = readSessionTranscriptWatermark(target);
        if (fresh.generation !== watermark.generation || fresh.maxSeq !== watermark.maxSeq) {
          throw new Error("CLI history changed before preparation");
        }
      },
    },
  );
  if (!committed || !allowed || boundary.state !== "known") {
    return undefined;
  }
  const assertActive = resolveAdmittedRunActiveAssertion(params.admittedRunContext);
  const assertWriterCurrent = () => {
    params.assertCurrent?.();
    if (!assertActive) {
      throw new Error("CLI history writer is no longer active");
    }
    assertActive();
  };
  return {
    target: { ...target },
    runId: writerRunId,
    authFingerprint: boundary.authFingerprint,
    lifecycleRevision: snapshot.lifecycleRevision,
    expectedWriterRunId: snapshot.activeWriterRunId,
    assertCurrent: assertWriterCurrent,
    assertReadable: () => {
      assertWriterCurrent();
      const current: InternalSessionEntry | undefined = loadSessionEntryReadOnly(target);
      const proof = current?.cliHistoryBoundary;
      const tip = readSessionTranscriptWatermark(target);
      if (
        !current ||
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== snapshot.lifecycleRevision ||
        current.activeWriterRunId !== snapshot.activeWriterRunId ||
        !isKnownCliHistoryBoundary(proof) ||
        proof.sessionId !== target.sessionId ||
        proof.writerRunId !== writerRunId ||
        proof.authFingerprint !== boundary.authFingerprint ||
        proof.generation !== tip.generation ||
        proof.maxSeq !== tip.maxSeq
      ) {
        throw new Error("CLI history authority changed before execution");
      }
    },
  };
}
