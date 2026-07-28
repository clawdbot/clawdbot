import {
  buildSkillWorkshopPromptSection,
  SKILL_WORKSHOP_TOOL_NAME,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { listRegisteredPluginAgentPromptGuidance } from "openclaw/plugin-sdk/plugin-runtime";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

export function buildDeveloperInstructions(
  params: EmbeddedRunAttemptParams,
  options: { dynamicTools?: readonly CodexDynamicToolSpec[] } = {},
): string {
  const nativeCommandGuidance = listRegisteredPluginAgentPromptGuidance({
    surface: "codex_app_server",
    includeLegacyGlobalGuidance: false,
  }).join("\n");
  const sections = [
    "You are a personal agent running inside OpenClaw. OpenClaw has dynamic tools for OpenClaw-owned messaging, cron, sessions, media, gateway, and nodes.",
    buildDeferredDynamicToolManifest(options.dynamicTools),
    buildSkillWorkshopInstruction(options.dynamicTools),
    // Codex defers native collab tools behind tool_search on search-capable
    // models (codex-rs spec_plan add_collaboration_tools). Without this hint
    // models cannot see spawn_agent and grab the always-direct sessions_spawn.
    "Use Codex native `spawn_agent` for Codex subagents. `spawn_agent` and the other native collaboration tools may be deferred: when `spawn_agent` is not directly listed, load it with `tool_search` before spawning. Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation, never as a substitute for `spawn_agent`.",
    buildVisibleReplyInstruction(params, options.dynamicTools),
    nativeCommandGuidance,
    params.extraSystemPrompt,
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

function buildDeferredDynamicToolManifest(
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string | undefined {
  const deferredToolNames = [
    ...new Set(
      flattenCodexDynamicToolFunctions(dynamicTools)
        .filter((tool) => tool.deferLoading === true)
        .map((tool) => tool.name.trim())
        .filter(Boolean),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  if (deferredToolNames.length === 0) {
    return undefined;
  }
  return `Deferred searchable OpenClaw dynamic tools available: ${deferredToolNames.join(", ")}. Use \`tool_search\` to load exact callable specs before use.`;
}

function buildSkillWorkshopInstruction(
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string | undefined {
  const hasSkillWorkshop = flattenCodexDynamicToolFunctions(dynamicTools).some(
    (tool) => tool.name.trim() === SKILL_WORKSHOP_TOOL_NAME,
  );
  if (!hasSkillWorkshop) {
    return undefined;
  }
  return buildSkillWorkshopPromptSection().join("\n");
}

function buildVisibleReplyInstruction(
  params: EmbeddedRunAttemptParams,
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string {
  const messageToolAvailable = dynamicTools
    ? flattenCodexDynamicToolFunctions(dynamicTools).some((tool) => tool.name.trim() === "message")
    : params.disableMessageTool !== true;
  if (params.sourceReplyDeliveryMode === "message_tool_only" && messageToolAvailable) {
    return "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. For progress, set `final=false`. When the message is the completed reply to the current source conversation, set `final=true`; OpenClaw stops after confirming delivery. If `final` is omitted, OpenClaw continues and resolves the latest omitted source reply only when the turn ends successfully. Do not repeat visible message content in your final answer.";
  }
  if (messageToolAvailable) {
    return "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation. Use `message` only for explicit out-of-band sends, media/file sends, or sends to a different target.";
  }
  return "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation.";
}
