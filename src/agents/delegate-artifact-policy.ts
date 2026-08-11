import { hasCrossSessionDelegateTargeting } from "../auto-reply/continuation/targeting-pure.js";
import type {
  ContinuationRuntimeConfig,
  PendingContinuationDelegate,
} from "../auto-reply/continuation/types.js";
import { resolveAgentIdFromSessionKey, resolveSessionStorePathCore } from "../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createDelegateArtifactPolicy,
  DELEGATE_ARTIFACT_OUTPUT_ROOT,
  type DelegateArtifactRecipientV1,
  type DelegateArtifactRouteV1,
} from "./delegate-artifacts.js";
import {
  deriveContinuationDelegateChildRunId,
  deriveContinuationDelegateChildSessionKeyFromParent,
} from "./subagent-continuation-ids.js";
import { listAncestorSessionKeys } from "./subagents/registry/subagent-registry-read.js";

export function formatDelegateArtifactTaskInstruction(
  delegate: Pick<PendingContinuationDelegate, "returnOptions">,
): string {
  const mode = delegate.returnOptions?.artifacts;
  if (mode !== "optional" && mode !== "required") {
    return "";
  }
  const requirement =
    mode === "required"
      ? "You must publish at least one valid artifact before completing."
      : "You may publish zero or more artifacts.";
  return (
    `\n\n[Managed delegate return]\n${requirement} ` +
    `Create output files under ${DELEGATE_ARTIFACT_OUTPUT_ROOT} and call ` +
    "delegate_artifacts_publish with paths relative to that directory. " +
    "Do not return paths, URLs, hashes, or bytes in final prose as a substitute."
  );
}

function loadSessionId(cfg: OpenClawConfig, sessionKey: string): string | undefined {
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return loadSessionEntry({
    agentId,
    sessionKey,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  })?.sessionId;
}

function allAddressableSessionKeys(cfg: OpenClawConfig): string[] {
  const keys = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly(target)) {
      if (entry.sessionId) {
        keys.add(sessionKey);
      }
    }
  }
  return [...keys].toSorted();
}

function resolveRoute(
  delegate: PendingContinuationDelegate,
  dispatchingSessionKey: string,
): {
  route: DelegateArtifactRouteV1;
  sessionKeys: string[];
} {
  const targetSessionKeys = [
    ...new Set([
      ...(delegate.targetSessionKey ? [delegate.targetSessionKey] : []),
      ...(delegate.targetSessionKeys ?? []),
    ]),
  ].toSorted();
  if (targetSessionKeys.length > 0) {
    return {
      route:
        targetSessionKeys.length === 1
          ? { kind: "target", targetSessionKey: targetSessionKeys[0]! }
          : { kind: "targets", targetSessionKeys },
      sessionKeys: targetSessionKeys,
    };
  }
  if (delegate.fanoutMode === "tree") {
    return {
      route: { kind: "fanout", fanoutMode: "tree" },
      sessionKeys: listAncestorSessionKeys(dispatchingSessionKey).toSorted(),
    };
  }
  if (delegate.fanoutMode === "all") {
    return {
      route: { kind: "fanout", fanoutMode: "all" },
      sessionKeys: [],
    };
  }
  return { route: { kind: "parent" }, sessionKeys: [] };
}

export function prepareDelegateArtifactPolicy(params: {
  cfg: OpenClawConfig;
  config: ContinuationRuntimeConfig;
  dispatchingSessionKey: string;
  delegate: PendingContinuationDelegate;
  flowId: string;
  dispatchRevision: number;
  acceptedAt?: number;
}): void {
  const artifactMode = params.delegate.returnOptions?.artifacts ?? "forbidden";
  if (artifactMode === "forbidden") {
    return;
  }
  if (!params.config.enabled) {
    throw new Error("artifact-capable continuation dispatch is disabled");
  }
  const sourceSessionId = loadSessionId(params.cfg, params.dispatchingSessionKey);
  if (!sourceSessionId) {
    throw new Error("artifact-capable continuation dispatch requires a durable source session");
  }
  const resolved = resolveRoute(params.delegate, params.dispatchingSessionKey);
  const recipientKeys =
    params.delegate.fanoutMode === "all"
      ? allAddressableSessionKeys(params.cfg)
      : resolved.sessionKeys.length > 0
        ? resolved.sessionKeys
        : [params.dispatchingSessionKey];
  const recipients: DelegateArtifactRecipientV1[] = [];
  for (const sessionKey of new Set(recipientKeys)) {
    const sessionId = loadSessionId(params.cfg, sessionKey);
    if (!sessionId) {
      throw new Error("artifact-capable continuation target is not a durable local session");
    }
    const relation = sessionKey === params.dispatchingSessionKey ? "parent" : "inter_session";
    if (relation === "inter_session" && !params.delegate.recipientContext?.purpose) {
      throw new Error("artifact-capable inter-session return requires recipientContext.purpose");
    }
    recipients.push({
      sessionKey,
      sessionId,
      relation,
      ...(relation === "inter_session" && params.delegate.recipientContext
        ? { purpose: params.delegate.recipientContext.purpose }
        : {}),
    });
  }
  if (recipients.length === 0) {
    throw new Error("artifact-capable continuation dispatch resolved no authorized recipients");
  }
  if (
    params.config.crossSessionTargeting === "disabled" &&
    hasCrossSessionDelegateTargeting(params.delegate, params.dispatchingSessionKey)
  ) {
    throw new Error("artifact-capable cross-session continuation dispatch is disabled");
  }
  createDelegateArtifactPolicy({
    flowId: params.flowId,
    producerSessionKey: deriveContinuationDelegateChildSessionKeyFromParent(
      params.dispatchingSessionKey,
      params.flowId,
    ),
    producerRunId: deriveContinuationDelegateChildRunId(params.flowId),
    originParentSessionKey: params.dispatchingSessionKey,
    originParentSessionId: sourceSessionId,
    dispatchRevision: params.dispatchRevision,
    ...(params.acceptedAt !== undefined ? { dispatchAcceptedAt: params.acceptedAt } : {}),
    ...(params.delegate.firstArmedAt !== undefined
      ? { scheduledAt: params.delegate.firstArmedAt }
      : {}),
    ...(params.delegate.firstArmedAt !== undefined && params.delegate.delayMs !== undefined
      ? { notBefore: params.delegate.firstArmedAt + params.delegate.delayMs }
      : {}),
    artifactMode,
    ...(params.delegate.recipientContext
      ? { recipientContext: params.delegate.recipientContext.purpose }
      : {}),
    recipients,
    route: resolved.route,
  });
}
