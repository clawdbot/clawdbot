/** Recovery helpers for stale ACP persistent session ids and early runtime exits. */
import { resolveSessionIdentityFromMeta } from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import type { AcpRuntimeError } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpSessionManagerDeps,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";

/** Detects acpx exits that are safe to retry with a fresh runtime handle. */
export function isRecoverableManagerAcpxExitError(message: string): boolean {
  return /^acpx exited with (code \d+|signal [a-z0-9]+)/i.test(message.trim());
}

/** acpx detail code for a persistent session that can no longer be resumed and must be re-created. */
const SESSION_RESUME_REQUIRED_DETAIL_CODE = "SESSION_RESUME_REQUIRED";

/**
 * Detects a "persistent session can no longer be resumed" failure by acpx's
 * structured detail code, on the error itself or anywhere in its cause chain.
 * Keying on the structured code rather than the human reason text is what makes
 * recovery independent of the backend's wording — Claude reports "Resource not
 * found", Kiro reports "Internal error" (RequestError -32603), but both wrap a
 * SessionResumeRequiredError; matching the reason text missed Kiro and left the
 * thread permanently stuck (#87830).
 */
function isRecoverableMissingManagerPersistentSessionError(error: AcpRuntimeError): boolean {
  let current: unknown = error;
  // Depth-capped to defend against self-referential cause cycles.
  for (let depth = 0; current && depth < 8; depth += 1) {
    if ((current as { detailCode?: unknown }).detailCode === SESSION_RESUME_REQUIRED_DETAIL_CODE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const TRANSIENT_CLOSED_TURN_ERROR_PATTERN = /\b(?:client|connection|query)(?: is)? closed\b/i;

function isRecoverableManagerTransientAcpTurnError(message: string): boolean {
  const normalized = message.trim();
  return normalized === "Internal error" || TRANSIENT_CLOSED_TURN_ERROR_PATTERN.test(normalized);
}

/** Prepares a one-time fresh-handle retry for recoverable pre-output runtime failures. */
export async function prepareFreshManagerRuntimeHandleRetry(params: {
  attempt: number;
  cfg: OpenClawConfig;
  sessionKey: string;
  error: AcpRuntimeError;
  sawTurnOutput: boolean;
  runtime?: AcpRuntime;
  meta?: SessionAcpMeta;
  runtimeHandles: ManagerRuntimeHandleCache;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<boolean> {
  if (params.attempt > 0 || params.sawTurnOutput) {
    return false;
  }
  if (isRecoverableManagerAcpxExitError(params.error.message)) {
    params.runtimeHandles.clear(params.sessionKey);
    logVerbose(
      `acp-manager: retrying ${params.sessionKey} with a fresh runtime handle after early turn failure: ${params.error.message}`,
    );
    return true;
  }
  if (
    params.runtime &&
    params.meta &&
    params.meta.mode === "persistent" &&
    isRecoverableMissingManagerPersistentSessionError(params.error)
  ) {
    const cleared = await clearPersistedRuntimeResumeState({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      writeSessionMeta: params.writeSessionMeta,
    });
    if (!cleared) {
      return false;
    }
    if (params.runtime.prepareFreshSession) {
      try {
        await params.runtime.prepareFreshSession({
          sessionKey: params.sessionKey,
        });
      } catch (error) {
        logVerbose(
          `acp-manager: failed preparing a fresh persistent session for ${params.sessionKey}: ${formatErrorMessage(error)}`,
        );
        return false;
      }
    }
    params.runtimeHandles.clear(params.sessionKey);
    logVerbose(
      `acp-manager: retrying ${params.sessionKey} with a fresh persistent session after missing backend resume target: ${params.error.message}`,
    );
    return true;
  }
  if (isRecoverableManagerTransientAcpTurnError(params.error.message)) {
    params.runtimeHandles.clear(params.sessionKey);
    logVerbose(
      `acp-manager: retrying ${params.sessionKey} with a fresh runtime handle after transient pre-output turn failure: ${params.error.message}`,
    );
    return true;
  }
  return false;
}

async function clearPersistedRuntimeResumeState(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<boolean> {
  const now = Date.now();
  const updated = await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    mutate: (current, entry) => {
      if (!entry) {
        return null;
      }
      const base = current;
      if (!base) {
        return null;
      }
      const currentIdentity = resolveSessionIdentityFromMeta(base);
      if (!currentIdentity?.acpxSessionId && !currentIdentity?.agentSessionId) {
        return base;
      }
      const nextIdentity = {
        state: "pending" as const,
        ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
        source: currentIdentity.source,
        lastUpdatedAt: now,
      };
      return {
        backend: base.backend,
        agent: base.agent,
        runtimeSessionName: base.runtimeSessionName,
        identity: nextIdentity,
        mode: base.mode,
        ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
        ...(base.cwd ? { cwd: base.cwd } : {}),
        state: base.state,
        lastActivityAt: now,
        ...(base.lastError ? { lastError: base.lastError } : {}),
      };
    },
  });
  if (!updated) {
    logVerbose(
      `acp-manager: unable to clear persisted runtime resume state for ${params.sessionKey}`,
    );
    return false;
  }
  return true;
}

/** Clears persisted runtime resume identifiers while preserving the manager session shell. */
export async function discardPersistedManagerRuntimeState(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<void> {
  const now = Date.now();
  await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    mutate: (current, entry) => {
      if (!entry) {
        return null;
      }
      const base = current;
      if (!base) {
        return null;
      }
      const currentIdentity = resolveSessionIdentityFromMeta(base);
      const nextIdentity = currentIdentity
        ? {
            state: "pending" as const,
            ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
            source: currentIdentity.source,
            lastUpdatedAt: now,
          }
        : undefined;
      return {
        backend: base.backend,
        agent: base.agent,
        runtimeSessionName: base.runtimeSessionName,
        ...(nextIdentity ? { identity: nextIdentity } : {}),
        mode: base.mode,
        ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
        ...(base.cwd ? { cwd: base.cwd } : {}),
        state: "idle",
        lastActivityAt: now,
      };
    },
    failOnError: true,
  });
}

export async function tryPrepareFreshManagerRuntimeSession(params: {
  deps: Pick<AcpSessionManagerDeps, "getRuntimeBackend">;
  cfg: OpenClawConfig;
  meta: SessionAcpMeta;
  sessionKey: string;
  logPrefix: string;
  missingBackendError?: unknown;
}): Promise<void> {
  const configuredBackend = (params.meta.backend || params.cfg.acp?.backend || "").trim();
  try {
    const backend = params.deps.getRuntimeBackend(configuredBackend || undefined);
    if (!backend) {
      if (params.missingBackendError) {
        throw toErrorObject(params.missingBackendError, "Non-Error thrown");
      }
      return;
    }
    await backend.runtime.prepareFreshSession?.({
      sessionKey: params.sessionKey,
    });
  } catch (error) {
    logVerbose(
      `${params.logPrefix}: unable to prepare fresh session for ${params.sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}
