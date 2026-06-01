import { resolveSessionIdentityFromMeta } from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AcpRuntimeError } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpSessionManagerDeps,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";

export function isRecoverableManagerAcpxExitError(message: string): boolean {
  return /^acpx exited with (code \d+|signal [a-z0-9]+)/i.test(message.trim());
}

function isRecoverableMissingManagerPersistentSessionError(message: string): boolean {
  const normalized = message.trim();
  return (
    /persistent acp session .* could not be resumed/i.test(normalized) &&
    /(resource not found|no matching session)/i.test(normalized)
  );
}

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
    !params.runtime ||
    !params.meta ||
    params.meta.mode !== "persistent" ||
    !isRecoverableMissingManagerPersistentSessionError(params.error.message)
  ) {
    return false;
  }
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
        throw toLintErrorObject(params.missingBackendError, "Non-Error thrown");
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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
