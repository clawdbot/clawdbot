// Model-backed compaction request construction.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { compactEmbeddedAgentSession } from "../../agents/embedded-agent.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import { preflightManualSessionCompaction } from "../../agents/sessions/manual-compaction-preflight.js";
import type { SessionEntry as AgentSessionEntry } from "../../agents/sessions/session-manager.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadTranscriptEvents,
  resolveSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  isCanonicalSessionTranscriptEntry,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../../config/sessions/transcript-tree.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionModelRef } from "../session-utils.js";

type GatewaySessionCompactionParams = {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  sessionId: string;
  sessionKey: string;
  sessionStoreKey: string;
  storePath: string;
};

function usesLegacyOpenClawCompaction(params: GatewaySessionCompactionParams): boolean {
  const persistedRuntime = params.entry.modelSelectionLocked
    ? resolvePersistedSessionRuntimeId(params.entry)
    : params.entry.agentHarnessId;
  const contextEngine = params.cfg.plugins?.slots?.contextEngine?.trim();
  return (
    (!persistedRuntime || persistedRuntime === "openclaw") &&
    (!contextEngine || contextEngine === "legacy")
  );
}

async function resolveGatewayCompactionTranscriptTarget(params: GatewaySessionCompactionParams) {
  return await resolveSessionTranscriptRuntimeTarget({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  });
}

/** Returns only definitive legacy-runtime no-op verdicts; other runtimes decide for themselves. */
export async function preflightGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
): Promise<{ reason: "Already compacted" | "Nothing to compact (session too small)" } | undefined> {
  if (!usesLegacyOpenClawCompaction(params)) {
    return undefined;
  }
  try {
    const transcriptEvents = await loadTranscriptEvents({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionStoreKey,
      storePath: params.storePath,
    });
    const tree = scanSessionTranscriptTree(transcriptEvents);
    const branch = selectSessionTranscriptTreePathNodes(tree, tree.leafId)
      .map((node) => node.entry)
      .filter(isCanonicalSessionTranscriptEntry) as unknown as AgentSessionEntry[];
    const preflight = preflightManualSessionCompaction(branch, {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 0,
    });
    return preflight.compactable ? undefined : { reason: preflight.reason };
  } catch {
    // Preserve the existing compaction error path for malformed or unavailable transcripts.
    return undefined;
  }
}

export async function runGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
): Promise<Awaited<ReturnType<typeof compactEmbeddedAgentSession>>> {
  const transcriptTarget = await resolveGatewayCompactionTranscriptTarget(params);
  const resolvedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: params.entry.spawnedBy,
      workspaceDir: params.entry.spawnedWorkspaceDir,
      cwd: params.entry.spawnedCwd,
    }) ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);

  return await compactEmbeddedAgentSession({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionTarget: {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    allowGatewaySubagentBinding: true,
    sessionFile: transcriptTarget.sessionKey,
    workspaceDir,
    cwd: normalizeOptionalString(params.entry.spawnedCwd),
    config: params.cfg,
    provider: resolvedModel.provider,
    model: resolvedModel.model,
    authProfileId: params.entry.authProfileOverride,
    authProfileIdSource:
      params.entry.authProfileOverrideSource ??
      (params.entry.authProfileOverride
        ? typeof params.entry.authProfileOverrideCompactionCount === "number"
          ? "auto"
          : "user"
        : undefined),
    agentHarnessId:
      params.entry.modelSelectionLocked === true
        ? resolvePersistedSessionRuntimeId(params.entry)
        : params.entry.agentHarnessId,
    modelSelectionLocked: params.entry.modelSelectionLocked === true,
    thinkLevel: normalizeThinkLevel(params.entry.thinkingLevel),
    reasoningLevel: normalizeReasoningLevel(params.entry.reasoningLevel),
    bashElevated: {
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    },
    trigger: "manual",
  });
}
