// Handles /learn by turning the command into a Skill Workshop authoring turn.
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import {
  agentHarnessExposesOpenClawTools,
  selectAgentHarness,
} from "../../agents/harness/selection.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "../../agents/model-runtime-aliases.js";
import { supportsModelTools } from "../../agents/model-tool-support.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { isToolAllowedByPolicyName } from "../../agents/tool-policy-match.js";
import { resolveConfiguredModelCompat } from "../../agents/tools-effective-inventory.js";
import { buildLearnPrompt, DEFAULT_LEARN_REQUEST } from "../../skills/workshop/learn-prompt.js";
import { resolveSkillWorkshopToolPolicyAvailability } from "../../skills/workshop/tool-policy-diagnostic.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

const LEARN_COMMAND_PREFIX = "/learn";
const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";
const SKILL_WORKSHOP_UNAVAILABLE_REPLY =
  "Skill workshop is not available on this agent. Use a non-sandboxed agent where the skill_workshop tool is available, or use the openclaw skills workshop CLI.";

function parseLearnRequest(raw: string): string | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (commandToken.toLowerCase() !== LEARN_COMMAND_PREFIX) {
    return null;
  }
  const request = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  return request || DEFAULT_LEARN_REQUEST;
}

function applyLearnPromptToContext(ctx: HandleCommandsParams["ctx"], instruction: string): void {
  const mutableCtx = ctx as HandleCommandsParams["ctx"] & {
    Body?: string;
    RawBody?: string;
    CommandBody?: string;
    BodyForCommands?: string;
    BodyForAgent?: string;
    BodyStripped?: string;
    commandText?: string;
    agentText?: string;
    rawText?: string;
  };
  mutableCtx.commandText = instruction;
  mutableCtx.agentText = instruction;
  mutableCtx.rawText = instruction;
  mutableCtx.Body = instruction;
  mutableCtx.RawBody = instruction;
  mutableCtx.CommandBody = instruction;
  mutableCtx.BodyForCommands = instruction;
  mutableCtx.BodyForAgent = instruction;
  mutableCtx.BodyStripped = instruction;
}

function applyLearnPrompt(params: HandleCommandsParams, instruction: string): void {
  applyLearnPromptToContext(params.ctx, instruction);
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    applyLearnPromptToContext(params.rootCtx, instruction);
  }
  params.command.rawBodyNormalized = instruction;
  params.command.commandBodyNormalized = instruction;
}

function workshopIsAvailable(params: HandleCommandsParams): boolean {
  if (params.opts?.disableTools) {
    return false;
  }
  if (params.opts?.toolsAllow?.length === 0) {
    return false;
  }
  if (
    params.opts?.toolsAllow !== undefined &&
    !isToolAllowedByPolicyName(SKILL_WORKSHOP_TOOL_NAME, { allow: params.opts.toolsAllow })
  ) {
    return false;
  }

  const policySessionKey = resolveRuntimePolicySessionKey({
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  if (
    resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: policySessionKey,
    }).sandboxed
  ) {
    return false;
  }

  try {
    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const runtimeOverride = targetSessionEntry?.agentRuntimeOverride;
    const cliProvider = isCliRuntimeAliasForProvider({
      provider: params.provider,
      runtime: runtimeOverride,
      cfg: params.cfg,
    })
      ? runtimeOverride
      : resolveCliRuntimeExecutionProvider({
          provider: params.provider,
          cfg: params.cfg,
          agentId: params.agentId,
          modelId: params.model,
          authProfileId: targetSessionEntry?.authProfileOverride,
        });
    if (cliProvider) {
      const cliBackend = resolveCliBackendConfig(cliProvider, params.cfg, {
        agentId: params.agentId,
      });
      if (!cliBackend?.bundleMcp) {
        return false;
      }
    } else {
      const harness = selectAgentHarness({
        provider: params.provider,
        modelId: params.model,
        config: params.cfg,
        agentId: params.agentId,
        sessionKey: policySessionKey,
      });
      if (!agentHarnessExposesOpenClawTools(harness.id)) {
        return false;
      }
    }
    const modelCompat = resolveConfiguredModelCompat({
      cfg: params.cfg,
      modelProvider: params.provider,
      modelId: params.model,
    });
    if (modelCompat && !supportsModelTools({ compat: modelCompat })) {
      return false;
    }
    const capabilityProfile = resolveConversationCapabilityProfile({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: policySessionKey ?? params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      runtimeToolAllowlist: params.opts?.toolsAllow,
      messageProvider: params.command.channel,
      senderId: params.command.senderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      senderIsOwner: params.command.senderIsOwner,
      agentAccountId: params.command.accountId ?? params.ctx.AccountId,
      modelProvider: params.provider,
      modelId: params.model,
      groupId: params.sessionEntry?.groupId,
      groupChannel: params.sessionEntry?.groupChannel ?? params.ctx.GroupChannel,
      groupSpace: params.sessionEntry?.space ?? params.ctx.GroupSpace,
    });
    return resolveSkillWorkshopToolPolicyAvailability({
      config: params.cfg,
      conversationCapabilityProfile: capabilityProfile,
    }).available;
  } catch {
    return false;
  }
}

function unavailableReply(): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text: SKILL_WORKSHOP_UNAVAILABLE_REPLY },
  };
}

/** Command handler for /learn skill-draft requests. */
export const handleLearnCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const request = parseLearnRequest(params.command.commandBodyNormalized);
  if (!request) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, LEARN_COMMAND_PREFIX);
  if (unauthorized) {
    return unauthorized;
  }
  if (!workshopIsAvailable(params)) {
    return unavailableReply();
  }

  applyLearnPrompt(params, buildLearnPrompt(request));
  return { shouldContinue: true };
};
