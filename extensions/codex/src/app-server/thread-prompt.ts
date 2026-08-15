import {
  buildSkillWorkshopPromptSection,
  SKILL_WORKSHOP_TOOL_NAME,
  TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { listRegisteredPluginAgentPromptGuidance } from "openclaw/plugin-sdk/plugin-runtime";
import {
  isMessageOnlyCodexSourceReply,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
  shouldDisableCodexToolSearchForModel,
} from "./dynamic-tool-profile.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolSpec,
} from "./protocol.js";

export function buildDeveloperInstructions(
  params: EmbeddedRunAttemptParams,
  options: { dynamicTools?: readonly CodexDynamicToolSpec[] } = {},
): string {
  const deferredToolNames = new Set<string>();
  let hasSkillWorkshop = false;
  let hasSessionsSpawn = false;
  let hasSessionsYield = false;
  let hasSeenDirectNamespace = false;
  let messageToolAvailable = options.dynamicTools ? false : params.disableMessageTool !== true;
  for (const spec of options.dynamicTools ?? []) {
    const isDirectNamespace =
      spec.type === "namespace" &&
      !hasSeenDirectNamespace &&
      spec.name.trim() === CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE;
    if (isDirectNamespace) {
      hasSeenDirectNamespace = true;
    }
    for (const tool of spec.type === "namespace" ? spec.tools : [spec]) {
      const name = tool.name.trim();
      if (tool.deferLoading === true && name) {
        deferredToolNames.add(name);
      }
      hasSkillWorkshop ||= name === SKILL_WORKSHOP_TOOL_NAME;
      hasSessionsSpawn ||= name === "sessions_spawn";
      hasSessionsYield ||= isDirectNamespace && name === "sessions_yield";
      messageToolAvailable ||= name === "message";
    }
  }
  const nativeCommandGuidance = listRegisteredPluginAgentPromptGuidance({
    surface: "codex_app_server",
    includeLegacyGlobalGuidance: false,
  }).join("\n");
  const nativeDelegationAvailable =
    params.disableTools !== true &&
    params.delegationCapability !== "report_only" &&
    !isMessageOnlyCodexSourceReply(params) &&
    !isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow) &&
    !shouldDisableCodexToolSearchForModel(params.modelId);
  const deferredToolDiscoveryGuidance =
    deferredToolNames.size > 0 || nativeDelegationAvailable
      ? "Deferred tools may be absent from the direct tool list. Use `tool_search` when directly callable. On code-mode-only models, use `exec` instead: filter `ALL_TOOLS` by name and description, then call the matching entry through `tools`."
      : undefined;
  const sections = [
    "You are a personal agent running inside OpenClaw. OpenClaw has dynamic tools for OpenClaw-owned messaging, cron, sessions, media, gateway, and nodes.",
    deferredToolNames.size > 0
      ? `Deferred searchable OpenClaw dynamic tools available: ${[...deferredToolNames]
          .toSorted((left, right) => left.localeCompare(right))
          .join(", ")}.`
      : undefined,
    deferredToolDiscoveryGuidance,
    hasSkillWorkshop ? buildSkillWorkshopPromptSection().join("\n") : undefined,
    // Codex defers native collab tools behind tool_search on search-capable
    // models (codex-rs spec_plan add_collaboration_tools). Without this hint
    // models cannot see spawn_agent and grab the always-direct sessions_spawn.
    nativeDelegationAvailable
      ? `Use Codex native \`spawn_agent\` for Codex subagents. \`spawn_agent\` and the other native collaboration tools may be deferred.${hasSessionsSpawn ? " Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation, never as a substitute for `spawn_agent`." : ""}`
      : undefined,
    hasSessionsYield && nativeDelegationAvailable
      ? "When a native child's result belongs in a later turn, end the current turn with `openclaw_direct.sessions_yield`; the completion arrives as the next model-visible input. Use native `wait_agent` only for an intentional same-turn wait when the immediate next step is blocked on the child. Never loop-poll for native child completion."
      : undefined,
    buildVisibleReplyInstruction(params, messageToolAvailable),
    TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT,
    nativeCommandGuidance,
    params.extraSystemPrompt,
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

function buildVisibleReplyInstruction(
  params: EmbeddedRunAttemptParams,
  messageToolAvailable: boolean,
): string {
  if (params.sourceReplyDeliveryMode === "message_tool_only" && messageToolAvailable) {
    return "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. For progress, set `final=false`. Set `final=true`, or omit it, for the completed reply to the current source conversation; OpenClaw stops after confirming delivery. Do not repeat visible message content in your final answer.";
  }
  if (messageToolAvailable) {
    return "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation. Use `message` for supported non-text actions in the current conversation, such as reacting to its current message. Reserve other `message` actions for explicit out-of-band sends or media/file delivery. Reactions are not delivered automatically.";
  }
  return "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation.";
}
