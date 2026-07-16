// Model-backed compaction request construction.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { compactEmbeddedAgentSession } from "../../agents/embedded-agent.js";
import { resolvePersistedSessionRuntimeId } from "../../agents/session-runtime-compat.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionModelRef } from "../session-utils.js";

export async function runGatewaySessionCompaction(params: {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  sessionId: string;
  sessionKey: string;
  sessionStoreKey: string;
  storePath: string;
}): Promise<Awaited<ReturnType<typeof compactEmbeddedAgentSession>>> {
  const transcriptTarget = await resolveSessionTranscriptRuntimeTarget({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  });
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
    sessionFile: transcriptTarget.sessionFile,
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
