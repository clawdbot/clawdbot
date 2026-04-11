import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import type { EmbeddedContextFile } from "../../agents/pi-embedded-helpers.js";
import { resolveEmbeddedFullAccessState } from "../../agents/pi-embedded-runner/sandbox-info.js";
import { createOpenClawCodingTools } from "../../agents/pi-tools.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import type { HandleCommandsParams } from "./commands-types.js";

export type CommandsSystemPromptBundle = {
  systemPrompt: string;
  tools: AgentTool[];
  skillsPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  sandboxRuntime: ReturnType<typeof resolveSandboxRuntimeStatus>;
};

export async function resolveCommandsSystemPromptBundle(
  params: HandleCommandsParams,
): Promise<CommandsSystemPromptBundle> {
  const workspaceDir = params.workspaceDir;
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.cfg,
    agentId: params.agentId,
  });
  const { bootstrapFiles, contextFiles: injectedFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
  });
  const skillsSnapshot = (() => {
    try {
      return buildWorkspaceSkillSnapshot(workspaceDir, {
        config: params.cfg,
        agentId: sessionAgentId,
        eligibility: {
          remote: getRemoteSkillEligibility({
            advertiseExecNode: canExecRequestNode({
              cfg: params.cfg,
              sessionEntry: targetSessionEntry,
              sessionKey: params.sessionKey,
              agentId: sessionAgentId,
            }),
          }),
        },
        snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
      });
    } catch {
      return { prompt: "", skills: [], resolvedSkills: [] };
    }
  })();
  const skillsPrompt = skillsSnapshot.prompt ?? "";
  const tools = (() => {
    try {
      return createOpenClawCodingTools({
        config: params.cfg,
        agentId: sessionAgentId,
        workspaceDir,
        sessionKey: params.sessionKey,
        allowGatewaySubagentBinding: true,
        messageProvider: params.command.channel,
        groupId: targetSessionEntry?.groupId ?? undefined,
        groupChannel: targetSessionEntry?.groupChannel ?? undefined,
        groupSpace: targetSessionEntry?.space ?? undefined,
        spawnedBy: targetSessionEntry?.spawnedBy ?? undefined,
        senderId: params.command.senderId,
        senderName: params.ctx.SenderName,
        senderUsername: params.ctx.SenderUsername,
        senderE164: params.ctx.SenderE164,
        senderIsOwner: params.command.senderIsOwner,
        modelProvider: params.provider,
        modelId: params.model,
      });
    } catch {
      return [];
    }
  })();
  const toolNames = tools.map((t) => t.name);
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: sessionAgentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.cfg,
    agentId: sessionAgentId,
    workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "unknown",
      os: "unknown",
      arch: "unknown",
      node: process.version,
      model: `${params.provider}/${params.model}`,
      defaultModel: defaultModelLabel,
    },
  });
  const fullAccessState = resolveEmbeddedFullAccessState({
    execElevated: {
      enabled: params.elevated.enabled,
      allowed: params.elevated.allowed,
      defaultLevel: (params.resolvedElevatedLevel ?? "off") as "on" | "off" | "ask" | "full",
    },
  });
  const sandboxInfo = sandboxRuntime.sandboxed
    ? {
        enabled: true,
        workspaceDir,
        workspaceAccess: "rw" as const,
        elevated: {
          allowed: params.elevated.allowed,
          defaultLevel: (params.resolvedElevatedLevel ?? "off") as "on" | "off" | "ask" | "full",
          fullAccessAvailable: fullAccessState.available,
          ...(fullAccessState.blockedReason
            ? { fullAccessBlockedReason: fullAccessState.blockedReason }
            : {}),
        },
      }
    : { enabled: false };
  const ttsHint = params.cfg ? buildTtsSystemPromptHint(params.cfg) : undefined;

  const systemPrompt = buildAgentSystemPrompt({
    workspaceDir,
    defaultThinkLevel: params.resolvedThinkLevel,
    reasoningLevel: params.resolvedReasoningLevel,
    extraSystemPrompt: undefined,
    ownerNumbers: undefined,
    reasoningTagHint: false,
    toolNames,
    modelAliasLines: [],
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: injectedFiles,
    skillsPrompt,
    heartbeatPrompt: undefined,
    ttsHint,
    acpEnabled: params.cfg?.acp?.enabled !== false,
    runtimeInfo,
    sandboxInfo,
    memoryCitationsMode: params.cfg?.memory?.citations,
  });

  return { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime };
}
