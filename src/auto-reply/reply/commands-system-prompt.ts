// Implements system prompt inspection commands for agent runtime sessions.
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import type { EmbeddedContextFile } from "../../agents/embedded-agent-helpers.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "../../agents/embedded-agent-runner/sandbox-skills.js";
import { resolveNodeExecEligibility } from "../../agents/exec-defaults.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../../agents/prompt-surface.js";
import type { AgentTool } from "../../agents/runtime/index.js";
import {
  ensureSandboxWorkspaceForSession,
  resolveSandboxRuntimeStatus,
} from "../../agents/sandbox.js";
import { buildConfiguredAgentSystemPrompt } from "../../agents/system-prompt-config.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../plugins/command-registry-state.js";
import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillEligibilityContext } from "../../skills/types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

type CommandsSystemPromptBundle = {
  systemPrompt: string;
  tools: AgentTool[];
  skillsPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  sandboxRuntime: ReturnType<typeof resolveSandboxRuntimeStatus>;
};

function resolveCommandSkillsEligibility(params: {
  agentId: string;
  config: HandleCommandsParams["cfg"];
  sessionEntry: HandleCommandsParams["sessionEntry"] | undefined;
  sessionKey: string | undefined;
}): SkillEligibilityContext {
  try {
    const nodeSkills = resolveNodeExecEligibility({
      cfg: params.config,
      sessionEntry: params.sessionEntry,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    return {
      nodeSkills,
      remote: getRemoteSkillEligibility({
        advertiseExecNode: nodeSkills.canExec,
      }),
    };
  } catch {
    try {
      return {
        nodeSkills: { canExec: false },
        remote: getRemoteSkillEligibility({
          advertiseExecNode: false,
        }),
      };
    } catch {
      return { nodeSkills: { canExec: false } };
    }
  }
}

async function resolveCommandSkillsPrompt(params: {
  agentId: string;
  config: HandleCommandsParams["cfg"];
  eligibility: SkillEligibilityContext;
  sandboxed: boolean;
  sessionKey: string | undefined;
  workspaceDir: string;
}): Promise<string> {
  if (params.sandboxed) {
    try {
      // Sandboxed prompt inspection must not fall back to host skill snapshots:
      // those paths can be unreadable inside the container.
      const sandboxWorkspace = await ensureSandboxWorkspaceForSession({
        config: params.config,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      });
      if (!sandboxWorkspace) {
        return "";
      }
      if (sandboxWorkspace.containerWorkdir) {
        const {
          skillsEligibility,
          skillsPromptWorkspaceDir,
          skillsSnapshot: skillsSnapshotForRun,
          skillsWorkspaceDir,
          workspaceOnly,
        } = resolveSandboxSkillRuntimeInputs({
          sandbox: {
            enabled: true,
            containerWorkdir: sandboxWorkspace.containerWorkdir,
            ...(sandboxWorkspace.skillsEligibility
              ? { skillsEligibility: sandboxWorkspace.skillsEligibility }
              : {}),
            ...(sandboxWorkspace.skillsWorkspaceDir
              ? { skillsWorkspaceDir: sandboxWorkspace.skillsWorkspaceDir }
              : {}),
            ...(sandboxWorkspace.workspaceAccess
              ? { workspaceAccess: sandboxWorkspace.workspaceAccess }
              : {}),
          },
          effectiveWorkspace: sandboxWorkspace.workspaceDir,
        });
        const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
          workspaceDir: skillsWorkspaceDir,
          config: params.config,
          agentId: params.agentId,
          eligibility: skillsEligibility,
          skillsSnapshot: skillsSnapshotForRun,
          workspaceOnly,
        });
        const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
          entries: shouldLoadSkillEntries ? skillEntries : undefined,
          skillsWorkspaceDir,
          skillsPromptWorkspaceDir,
        });
        return resolveSkillsPromptForRun({
          skillsSnapshot: skillsSnapshotForRun,
          entries: promptSkillEntries,
          config: params.config,
          workspaceDir: skillsPromptWorkspaceDir,
          agentId: params.agentId,
          eligibility: skillsEligibility,
        });
      }
      // Existing third-party backends may not expose the optional workdir
      // resolver yet. Preserve their previous host-snapshot inspection path.
    } catch {
      return "";
    }
  }

  try {
    const skillsSnapshot = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: params.workspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility: params.eligibility,
      watch: false,
    });
    return skillsSnapshot.snapshot.prompt ?? "";
  } catch {
    return "";
  }
}

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
    agentId: sessionAgentId,
  });
  const toolPolicySessionKey = resolveRuntimePolicySessionKey({
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: toolPolicySessionKey,
  });
  const skillsEligibility = resolveCommandSkillsEligibility({
    agentId: sessionAgentId,
    config: params.cfg,
    sessionEntry: targetSessionEntry,
    sessionKey: params.sessionKey,
  });
  const skillsPrompt = await resolveCommandSkillsPrompt({
    agentId: sessionAgentId,
    config: params.cfg,
    eligibility: skillsEligibility,
    sandboxed: sandboxRuntime.sandboxed,
    sessionKey: toolPolicySessionKey,
    workspaceDir,
  });
  const tools = (() => {
    try {
      return createOpenClawCodingTools({
        config: params.cfg,
        agentId: sessionAgentId,
        workspaceDir,
        sessionKey: toolPolicySessionKey,
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
        modelProvider: params.provider,
        modelId: params.model,
      });
    } catch {
      return [];
    }
  })();
  const toolNames = tools.map((t) => t.name);
  const promptSurface = resolveAgentPromptSurfaceForSessionKey(params.sessionKey);
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
      sessionKey: params.sessionKey,
      sessionId: targetSessionEntry?.sessionId,
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
  const systemPrompt = buildConfiguredAgentSystemPrompt({
    config: params.cfg,
    agentId: sessionAgentId,
    workspaceDir,
    defaultThinkLevel: params.resolvedThinkLevel,
    reasoningLevel: params.resolvedReasoningLevel,
    extraSystemPrompt: undefined,
    ownerNumbers: undefined,
    reasoningTagHint: false,
    toolNames,
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: injectedFiles,
    skillsPrompt,
    heartbeatPrompt: undefined,
    acpEnabled: isAcpRuntimeSpawnAvailable({
      config: params.cfg,
      sandboxed: sandboxRuntime.sandboxed,
    }),
    promptSurface,
    nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
      surface: promptSurface,
    }),
    runtimeInfo,
    sandboxInfo,
  });

  return { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime };
}
