import {
  resolveSessionWorkStartError,
  SessionWorkStartInvalidatedError,
} from "../config/sessions/lifecycle.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  createSessionDiffBaselineCaptureClaim,
  type SessionDiffBaselineCapture,
} from "../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry, SessionDiffBaseline } from "../config/sessions/types.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";

const captureInFlight = resolveGlobalMap<string, Promise<InternalSessionEntry>>(
  Symbol.for("openclaw.sessionDiffBaselineCaptureInFlight"),
  async (captures) => {
    await Promise.allSettled(captures.values());
    captures.clear();
  },
);

function matchingCapture(entry: InternalSessionEntry): SessionDiffBaselineCapture | undefined {
  const capture = entry.sessionDiffBaselineCapture;
  return capture?.version === 1 ? capture : undefined;
}

function invalidatedSessionWork(params: {
  entry: InternalSessionEntry | null;
  expectedSessionId: string;
  sessionKey: string;
}): SessionWorkStartInvalidatedError {
  return new SessionWorkStartInvalidatedError(
    resolveSessionWorkStartError(params.sessionKey, params.entry, {
      expectedSessionId: params.expectedSessionId,
    }) ?? `Session "${params.sessionKey}" changed while starting work. Retry.`,
  );
}

function requireAuthoritativeGeneration(params: {
  entry: InternalSessionEntry | null;
  expectedLifecycleRevision: string | undefined;
  expectedSessionId: string;
  sessionKey: string;
}): InternalSessionEntry {
  if (
    !params.entry ||
    params.entry.sessionId !== params.expectedSessionId ||
    params.entry.lifecycleRevision !== params.expectedLifecycleRevision
  ) {
    throw invalidatedSessionWork(params);
  }
  return params.entry;
}

async function persistCaptureResult(params: {
  capture: SessionDiffBaselineCapture;
  expectedLifecycleRevision: string | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  baseline?: SessionDiffBaseline;
}): Promise<InternalSessionEntry> {
  const persisted = await patchSessionEntryCore(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (currentEntry) => {
      const current = currentEntry;
      const currentCapture = matchingCapture(current);
      if (
        current.sessionId !== params.sessionId ||
        currentCapture?.captureId !== params.capture.captureId ||
        currentCapture.status !== "pending"
      ) {
        return null;
      }
      return params.baseline
        ? ({
            sessionDiffBaseline: params.baseline,
            sessionDiffBaselineCapture: undefined,
          } satisfies Partial<InternalSessionEntry>)
        : ({
            sessionDiffBaselineCapture: { ...params.capture, status: "unavailable" },
          } satisfies Partial<InternalSessionEntry>);
    },
    { preserveActivity: true, skipMaintenance: true },
  );
  const authoritative = requireAuthoritativeGeneration({
    entry: persisted,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    expectedSessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  if (authoritative.sessionDiffBaseline?.sessionId === params.sessionId) {
    return authoritative;
  }
  const authoritativeCapture = matchingCapture(authoritative);
  if (
    authoritativeCapture?.captureId === params.capture.captureId &&
    authoritativeCapture.status === "unavailable"
  ) {
    return authoritative;
  }
  throw invalidatedSessionWork({
    entry: authoritative,
    expectedSessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
}

async function settleCapture(params: {
  capture: SessionDiffBaselineCapture;
  cwd: string;
  expectedLifecycleRevision: string | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<InternalSessionEntry> {
  let baseline: SessionDiffBaseline | undefined;
  try {
    const { captureSessionDiffBaseline } = await import("./session-diff.js");
    baseline = await captureSessionDiffBaseline({
      cwd: params.cwd,
      sessionId: params.sessionId,
    });
  } catch (error) {
    await persistCaptureResult(params);
    throw error;
  }
  return await persistCaptureResult({ ...params, baseline });
}

export async function ensureSessionDiffBaseline(params: {
  cwd: string;
  entry: InternalSessionEntry;
  isNewSession: boolean;
  sessionKey: string;
  storePath: string;
}): Promise<InternalSessionEntry> {
  if (
    params.entry.execNode ||
    params.entry.sessionDiffBaseline?.sessionId === params.entry.sessionId
  ) {
    return params.entry;
  }

  let entry = params.entry;
  let capture = matchingCapture(entry);
  if (!capture) {
    if (!params.isNewSession || entry.createdVia !== "operator") {
      return entry;
    }
    const expectedSessionId = entry.sessionId;
    const expectedLifecycleRevision = entry.lifecycleRevision;
    const pending = createSessionDiffBaselineCaptureClaim();
    const armed = await patchSessionEntryCore(
      { sessionKey: params.sessionKey, storePath: params.storePath },
      (currentEntry) => {
        const current = currentEntry;
        if (
          current.sessionId !== expectedSessionId ||
          current.sessionDiffBaseline?.sessionId === current.sessionId ||
          matchingCapture(current)
        ) {
          return null;
        }
        return { sessionDiffBaselineCapture: pending } satisfies Partial<InternalSessionEntry>;
      },
      { preserveActivity: true, skipMaintenance: true },
    );
    entry = requireAuthoritativeGeneration({
      entry: armed,
      expectedLifecycleRevision,
      expectedSessionId,
      sessionKey: params.sessionKey,
    });
    if (entry.sessionDiffBaseline?.sessionId === entry.sessionId) {
      return entry;
    }
    capture = matchingCapture(entry);
  }
  if (!capture || capture.status === "unavailable") {
    return entry;
  }

  return await getOrCreatePromise(
    captureInFlight,
    capture.captureId,
    () =>
      settleCapture({
        ...params,
        capture,
        expectedLifecycleRevision: entry.lifecycleRevision,
        sessionId: entry.sessionId,
      }),
    { evictOnSettled: true },
  );
}
