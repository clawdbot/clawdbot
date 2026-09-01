import {
  buildCredentialSafetyPrompt,
  buildDelegationGuidanceSection,
  buildHarnessVisibleReplyGuidance,
  buildSkillWorkshopPromptSection,
  resolveMainSessionDelegationMode,
  SKILL_WORKSHOP_TOOL_NAME,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  normalizeUniqueStringEntries,
  readNonEmptyStringPreservingWhitespace as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isRawCopilotModelRun } from "./attempt-mode.js";
import type { AttemptParamsLike } from "./attempt-types.js";

const COPILOT_HARNESS_IDENTITY =
  "You are a personal agent running inside OpenClaw. Your available OpenClaw capabilities are policy-filtered for this turn; use only the exact tools exposed to you.";

export function buildCopilotPromptGuidance(params: {
  attempt: AttemptParamsLike;
  callableToolNames: Iterable<string>;
  workspaceBootstrapInstructions?: string;
}): string | undefined {
  if (isRawCopilotModelRun(params.attempt)) {
    return undefined;
  }
  const callableTools = new Set(normalizeUniqueStringEntries(params.callableToolNames));
  const hasSessionsSpawn = callableTools.has("sessions_spawn");
  const isMinimal = params.attempt.promptMode === "minimal";
  const extraSystemPrompt = readNonEmptyString(params.attempt.extraSystemPrompt)?.trim();
  const delegationGuidance =
    params.attempt.disableTools !== true && params.attempt.delegationCapability !== "report_only"
      ? buildDelegationGuidanceSection({
          mode: resolveMainSessionDelegationMode({
            config: params.attempt.config,
            agentId: params.attempt.agentId,
            sessionKey: params.attempt.sessionKey,
          }),
          isMinimal,
          hiddenDelegationTool: hasSessionsSpawn ? "`sessions_spawn`" : "",
          hasVisibleSessionSpawn: hasSessionsSpawn,
          hasSessionsYield: callableTools.has("sessions_yield"),
          hasSubagentsList: callableTools.has("subagents"),
          hasSessionsSend: callableTools.has("sessions_send"),
        }).join("\n")
      : undefined;
  const sections = [
    COPILOT_HARNESS_IDENTITY,
    callableTools.has(SKILL_WORKSHOP_TOOL_NAME)
      ? buildSkillWorkshopPromptSection().join("\n")
      : undefined,
    delegationGuidance,
    buildHarnessVisibleReplyGuidance({
      sourceReplyDeliveryMode: params.attempt.sourceReplyDeliveryMode,
      messageToolAvailable: callableTools.has("message"),
    }),
    buildCredentialSafetyPrompt(
      params.attempt.disableTools !== true && callableTools.has("secrets") ? "secrets" : undefined,
    ),
    params.workspaceBootstrapInstructions?.trim(),
    extraSystemPrompt
      ? `${isMinimal ? "## Subagent Context" : "## Conversation Context"}\n${extraSystemPrompt}`
      : undefined,
  ];
  return sections.filter((section) => section?.trim()).join("\n\n") || undefined;
}
