import {
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpSessionTarget } from "./manager.types.js";

/** Old backends can isolate qualified keys, but silently ignore an added owner field. */
export function assertAcpRuntimeOwnerSupport(runtime: AcpRuntime, target: AcpSessionTarget): void {
  if (!parseAgentSessionKey(target.sessionKey) && runtime.ownerAwareSessions !== 1) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "This ACP backend cannot isolate bare session keys by owner. Upgrade the backend to support ownerAwareSessions version 1.",
      { detailCode: "SESSION_OWNER_UNSUPPORTED" },
    );
  }
}

/** These operator repairs must never become resume recovery, failover, or a successful reset. */
export function isAcpOwnerRepairRequired(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    const detail = "detailCode" in current ? current.detailCode : undefined;
    if (detail === "SESSION_OWNER_MIGRATION_REQUIRED" || detail === "SESSION_OWNER_UNSUPPORTED") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function persistedAcpRuntimeHandle(
  target: AcpSessionTarget,
  meta: SessionAcpMeta,
): AcpRuntimeHandle {
  const identity = resolveSessionIdentityFromMeta(meta);
  return {
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    backend: meta.backend,
    runtimeSessionName: meta.runtimeSessionName,
    cwd: meta.cwd,
    acpxRecordId: identity?.acpxRecordId,
    ...resolveRuntimeHandleIdentifiersFromIdentity(identity),
  };
}
