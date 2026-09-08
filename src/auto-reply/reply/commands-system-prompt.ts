// Implements system prompt inspection commands for agent runtime sessions.
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import type { EmbeddedContextFile } from "../../agents/embedded-agent-helpers.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "../../agents/embedded-agent-runner/sandbox-skills.js";
import { resolveNodeExecEligibility } from "../../agents/exec-defaults.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../../agents/prompt-surface.js";
import { resolveAgentRuntimePrompt } from "../../agents/runtime-prompt.js";
import type { AgentTool } from "../../agents/runtime/index.js";
import {
  ensureSandboxWorkspaceForSession,
  resolveSandboxRuntimeStatus,
} from "../../agents/sandbox.js";
import { buildConfiguredAgentSystemPrompt } from "../../agents/system-prompt-config.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../plugins/command-registry-state.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../../skills/types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

const log = createSubsystemLogger("auto-reply/commands-system-prompt");

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
  sandboxAgentId: string;
  sandboxed: boolean;
  sessionKey: string | undefined;
  workspaceDir: string; // Preserve the caller's sandbox task root.
  executionWorkspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
}): Promise<string> {
  let skillsSnapshot: SkillSnapshot;
  try {
    skillsSnapshot = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: resolveAgentWorkspaceDir(params.config, params.agentId),
      executionWorkspaceDir: params.executionWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility: params.eligibility,
      existingSnapshot: params.skillsSnapshot,
      skillFilter: params.skillsSnapshot?.skillFilter,
      skillOverrides: params.skillsSnapshot?.skillOverrides,
      watch: false,
    }).snapshot;
  } catch {
    return "";
  }
  if (params.sandboxed) {
    try {
      // Sandboxed prompt inspection must not fall back to host skill snapshots:
      // those paths can be unreadable inside the container.
      const sandboxWorkspace = await ensureSandboxWorkspaceForSession({
        skillsSnapshot,
        config: params.config,
        agentId: params.sandboxAgentId,
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
            ...(sandboxWorkspace.skillUsagePaths
              ? { skillUsagePaths: sandboxWorkspace.skillUsagePaths }
              : {}),
            ...(sandboxWorkspace.workspaceAccess
              ? { workspaceAccess: sandboxWorkspace.workspaceAccess }
              : {}),
          },
          skillsAnchorWorkspace: sandboxWorkspace.workspaceDir,
          skillsSnapshot,
        });
        const { shouldLoadSkillEntries, skillEntries, preserveEntryOrder } =
          resolveEmbeddedRunSkillEntries({
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
        return resolveSkillsPrompt({
          skillsSnapshot: skillsSnapshotForRun,
          entries: promptSkillEntries,
          config: params.config,
          workspaceDir: skillsPromptWorkspaceDir,
          agentId: params.agentId,
          eligibility: skillsEligibility,
          preserveEntryOrder,
        });
      }
      // Existing third-party backends may not expose the optional workdir
      // resolver yet. Preserve their previous host-snapshot inspection path.
    } catch {
      return "";
    }
  }

  return skillsSnapshot.prompt;
}

export async function resolveCommandsSystemPromptBundle(
  params: HandleCommandsParams,
): Promise<CommandsSystemPromptBundle> {
  const workspaceDir = params.workspaceDir;
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const sessionAgentId = params.agentId;
  const { bootstrapFiles, contextFiles: injectedFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    chatType: targetSessionEntry?.chatType,
    agentId: sessionAgentId,
    warn: makeBootstrapWarn({
      sessionLabel: params.sessionKey,
      workspaceDir,
      warn: (message) => log.warn(message),
    }),
  });
  const toolPolicySessionKey = resolveRuntimePolicySessionKey({
    agentId: sessionAgentId,
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: toolPolicySessionKey,
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
    sandboxAgentId: sandboxRuntime.classificationAgentId,
    sandboxed: sandboxRuntime.sandboxed,
    sessionKey: toolPolicySessionKey,
    workspaceDir,
    executionWorkspaceDir: targetSessionEntry?.worktree?.canonicalWorkspaceDir ?? workspaceDir,
    skillsSnapshot: targetSessionEntry?.skillsSnapshot,
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
  const accountId = params.command.accountId ?? params.ctx.AccountId;
  const { runtimeInfo, userTimezone, userDate, reactionGuidance, messageToolHints } =
    await resolveAgentRuntimePrompt({
      config: params.cfg,
      agentId: sessionAgentId,
      workspaceDir,
      cwd: process.cwd(),
      sessionKey: params.sessionKey,
      sessionId: targetSessionEntry?.sessionId,
      model: `${params.provider}/${params.model}`,
      channel: params.command.channel,
      accountId,
      chatType: normalizeChatType(params.ctx.ChatType ?? targetSessionEntry?.chatType),
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
    reasoningLevel: params.resolvedReasoningLevel,
    extraSystemPrompt: undefined,
    ownerNumbers: undefined,
    reasoningTagHint: false,
    toolNames,
    userTimezone,
    userDate,
    contextFiles: injectedFiles,
    skillsPrompt,
    acpEnabled: isAcpRuntimeSpawnAvailable({
      config: params.cfg,
      sandboxed: sandboxRuntime.sandboxed,
    }),
    promptSurface,
    nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
      surface: promptSurface,
    }),
    reactionGuidance,
    messageToolHints,
    runtimeInfo,
    sandboxInfo,
  });

  return { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime };
}
