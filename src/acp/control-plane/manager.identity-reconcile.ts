import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import {
  createIdentityFromHandleEvent,
  createIdentityFromStatus,
  identityEquals,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "../runtime/session-identity.js";
import type { AcpRuntime, AcpRuntimeHandle, AcpRuntimeStatus } from "../runtime/types.js";
import type { SessionAcpMeta, SessionEntry } from "./manager.types.js";
import { hasLegacyAcpIdentityProjection } from "./manager.utils.js";

export async function reconcileManagerRuntimeSessionIdentifiers(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  runtimeStatus?: AcpRuntimeStatus;
  failOnStatusError: boolean;
  setCachedHandle: (sessionKey: string, handle: AcpRuntimeHandle) => void;
  writeSessionMeta: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    mutate: (
      current: SessionAcpMeta | undefined,
      entry: SessionEntry | undefined,
    ) => SessionAcpMeta | null | undefined;
    failOnError?: boolean;
  }) => Promise<SessionEntry | null>;
}): Promise<{
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  runtimeStatus?: AcpRuntimeStatus;
}> {
  let runtimeStatus = params.runtimeStatus;
  if (!runtimeStatus && params.runtime.getStatus) {
    try {
      runtimeStatus = await withAcpRuntimeErrorBoundary({
        run: async () =>
          await params.runtime.getStatus!({
            handle: params.handle,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not read ACP runtime status.",
      });
    } catch (error) {
      if (params.failOnStatusError) {
        throw error;
      }
      logVerbose(
        `acp-manager: failed to refresh ACP runtime status for ${params.sessionKey}: ${String(error)}`,
      );
      return {
        handle: params.handle,
        meta: params.meta,
        runtimeStatus,
      };
    }
  }

  const now = Date.now();
  const currentIdentity = resolveSessionIdentityFromMeta(params.meta);
  const eventIdentity = createIdentityFromHandleEvent({
    handle: params.handle,
    now,
  });
  const identityAfterEvent =
    mergeSessionIdentity({
      current: currentIdentity,
      incoming: eventIdentity,
      now,
    }) ?? currentIdentity;
  const nextIdentity =
    mergeSessionIdentity({
      current: identityAfterEvent,
      incoming: createIdentityFromStatus({
        status: runtimeStatus,
        now,
      }),
      now,
    }) ?? identityAfterEvent;
  const handleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
  const handleChanged =
    handleIdentifiers.backendSessionId !== params.handle.backendSessionId ||
    handleIdentifiers.agentSessionId !== params.handle.agentSessionId;
  const nextHandle: AcpRuntimeHandle = handleChanged
    ? {
        ...params.handle,
        ...(handleIdentifiers.backendSessionId
          ? { backendSessionId: handleIdentifiers.backendSessionId }
          : {}),
        ...(handleIdentifiers.agentSessionId
          ? { agentSessionId: handleIdentifiers.agentSessionId }
          : {}),
      }
    : params.handle;
  if (handleChanged) {
    params.setCachedHandle(params.sessionKey, nextHandle);
  }

  const metaChanged =
    !identityEquals(currentIdentity, nextIdentity) || hasLegacyAcpIdentityProjection(params.meta);
  if (!metaChanged) {
    return {
      handle: nextHandle,
      meta: params.meta,
      runtimeStatus,
    };
  }
  const nextMeta: SessionAcpMeta = {
    backend: params.meta.backend,
    agent: params.meta.agent,
    runtimeSessionName: params.meta.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: params.meta.mode,
    ...(params.meta.runtimeOptions ? { runtimeOptions: params.meta.runtimeOptions } : {}),
    ...(params.meta.cwd ? { cwd: params.meta.cwd } : {}),
    lastActivityAt: now,
    state: params.meta.state,
    ...(params.meta.lastError ? { lastError: params.meta.lastError } : {}),
  };
  if (!identityEquals(currentIdentity, nextIdentity)) {
    const currentAgentSessionId = currentIdentity?.agentSessionId ?? "<none>";
    const nextAgentSessionId = nextIdentity?.agentSessionId ?? "<none>";
    const currentAcpxSessionId = currentIdentity?.acpxSessionId ?? "<none>";
    const nextAcpxSessionId = nextIdentity?.acpxSessionId ?? "<none>";
    const currentAcpxRecordId = currentIdentity?.acpxRecordId ?? "<none>";
    const nextAcpxRecordId = nextIdentity?.acpxRecordId ?? "<none>";
    logVerbose(
      `acp-manager: session identity updated for ${params.sessionKey} ` +
        `(agentSessionId ${currentAgentSessionId} -> ${nextAgentSessionId}, ` +
        `acpxSessionId ${currentAcpxSessionId} -> ${nextAcpxSessionId}, ` +
        `acpxRecordId ${currentAcpxRecordId} -> ${nextAcpxRecordId})`,
    );
  }
  await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    mutate: (current, entry) => {
      if (!entry) {
        return null;
      }
      const base = current ?? entry.acp;
      if (!base) {
        return null;
      }
      return {
        backend: base.backend,
        agent: base.agent,
        runtimeSessionName: base.runtimeSessionName,
        ...(nextIdentity ? { identity: nextIdentity } : {}),
        mode: base.mode,
        ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
        ...(base.cwd ? { cwd: base.cwd } : {}),
        state: base.state,
        lastActivityAt: now,
        ...(base.lastError ? { lastError: base.lastError } : {}),
      };
    },
  });
  return {
    handle: nextHandle,
    meta: nextMeta,
    runtimeStatus,
  };
}
