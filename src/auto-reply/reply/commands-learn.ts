// Handles /learn by turning the command into a Skill Workshop authoring turn.
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { detectNodeClaudePlacement } from "../../agents/cli-runner/prepare-claude.js";
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
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

const LEARN_COMMAND_PREFIX = "/learn";
const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";
const SKILL_WORKSHOP_UNAVAILABLE_REPLY =
  "Skill workshop is not available on this agent. Use a non-sandboxed agent where the skill_workshop tool is available, or use the openclaw skills workshop CLI.";
const PERSONAL_WORKSHOP_LEARN_REPLY =
  "This turn cannot stage a pending workspace proposal, so /learn made no change. Ordinary explicit personal skill creation publishes a revision. Ask for that directly if intended, or use the existing administrator UI or openclaw skills workshop CLI for workspace proposal review.";

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

function resolveWorkshopSurface(
  params: HandleCommandsParams,
): "workspace" | "personal" | undefined {
  if (params.opts?.disableTools) {
    return undefined;
  }
  if (params.opts?.toolsAllow?.length === 0) {
    return undefined;
  }
  if (
    params.opts?.toolsAllow !== undefined &&
    !isToolAllowedByPolicyName(SKILL_WORKSHOP_TOOL_NAME, { allow: params.opts.toolsAllow })
  ) {
    return undefined;
  }

  const policySessionKey = resolveRuntimePolicySessionKey({
    agentId: params.agentId,
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: policySessionKey,
  });
  let personalOnly = params.opts?.skillLibraryAuthoring?.defaultTarget === "personal";

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
        return undefined;
      }
      if (
        detectNodeClaudePlacement({
          backendId: cliBackend.id,
          execHost: targetSessionEntry?.execHost,
          execNode: targetSessionEntry?.execNode,
        })
      ) {
        if (!params.opts?.skillLibraryAuthoring) {
          return undefined;
        }
        personalOnly = true;
      }
    } else {
      const harness = selectAgentHarness({
        provider: params.provider,
        modelId: params.model,
        config: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      if (!agentHarnessExposesOpenClawTools(harness.id)) {
        return undefined;
      }
    }
    const modelCompat = resolveConfiguredModelCompat({
      cfg: params.cfg,
      modelProvider: params.provider,
      modelId: params.model,
    });
    if (modelCompat && !supportsModelTools({ compat: modelCompat })) {
      return undefined;
    }
    const capabilityProfile = resolveConversationCapabilityProfile({
      config: params.cfg,
      agentId: sandboxRuntime.classificationAgentId,
      sessionKey: sandboxRuntime.classificationSessionKey,
      runSessionKey: params.sessionKey,
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
    const available = resolveSkillWorkshopToolPolicyAvailability({
      config: params.cfg,
      conversationCapabilityProfile: capabilityProfile,
    }).available;
    return available && (personalOnly || !sandboxRuntime.sandboxed)
      ? personalOnly
        ? "personal"
        : "workspace"
      : undefined;
  } catch {
    return undefined;
  }
}

/** Command handler for /learn skill-draft requests. */
export const handleLearnCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: LEARN_COMMAND_PREFIX, match: parseLearnRequest },
  (params, request) => {
    const surface = resolveWorkshopSurface(params);
    if (!surface) {
      return commandReply(SKILL_WORKSHOP_UNAVAILABLE_REPLY);
    }
    if (surface === "personal") {
      return commandReply(PERSONAL_WORKSHOP_LEARN_REPLY);
    }

    applyCommandTextToParams(params, buildLearnPrompt(request));
    return { shouldContinue: true };
  },
);
