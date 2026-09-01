/**
 * Warns when assistant text appears to expose raw tool-call syntax.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AssistantMessage } from "../llm/types.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { detectAssistantTranscriptRoleHeaderText } from "../shared/text/assistant-transcript-role-headers.js";
import { detectToolCallShapedText } from "../shared/text/tool-call-shaped-text.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

// Detect provider/model bugs where a reply serializes a tool call as plain
// assistant text instead of emitting a structured invocation block.
function hasStructuredToolInvocation(message: AssistantMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const rawType = Reflect.get(block, "type");
    const type = typeof rawType === "string" ? rawType.trim() : "";
    if (
      type === "toolCall" ||
      type === "toolUse" ||
      type === "tool_call" ||
      type === "tool_use" ||
      type === "functionCall" ||
      type === "function_call"
    ) {
      return true;
    }
    return (
      Array.isArray(Reflect.get(block, "tool_calls")) ||
      Array.isArray(Reflect.get(block, "toolCalls"))
    );
  });
}

function isRegisteredToolName(
  toolName: string | undefined,
  registeredToolNames: ReadonlySet<string> | undefined,
): boolean | undefined {
  if (!toolName || !registeredToolNames) {
    return undefined;
  }
  const normalized = normalizeToolPolicyName(toolName);
  for (const registeredToolName of registeredToolNames) {
    if (normalizeToolPolicyName(registeredToolName) === normalized) {
      return true;
    }
  }
  return false;
}

/** Log safe metadata for suspicious assistant-authored text shapes. */
export function warnIfAssistantEmittedSuspiciousText(
  ctx: EmbeddedAgentSubscribeContext,
  assistantMessage: AssistantMessage,
) {
  const structuredToolInvocation = hasStructuredToolInvocation(assistantMessage);
  const text =
    extractTextFromChatContent(assistantMessage.content, {
      joinWith: "\n",
      normalizeText: (chunk) => chunk.trim(),
    }) ?? "";
  const toolDetection = structuredToolInvocation ? null : detectToolCallShapedText(text);
  if (toolDetection) {
    const provider = normalizeOptionalString((assistantMessage as { provider?: unknown }).provider);
    const model = normalizeOptionalString((assistantMessage as { model?: unknown }).model);
    const registeredTool = isRegisteredToolName(toolDetection.toolName, ctx.builtinToolNames);
    const sessionId = normalizeOptionalString((ctx.params.session as { id?: unknown }).id);
    ctx.log.warn(
      "Assistant reply looks like a tool call, but no structured tool invocation was emitted; treating it as text.",
      {
        runId: ctx.params.runId,
        ...(sessionId ? { sessionId } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        pattern: toolDetection.kind,
        ...(toolDetection.toolName ? { toolName: toolDetection.toolName } : {}),
        ...(registeredTool !== undefined ? { registeredTool } : {}),
      },
    );
  }
  const roleDetection = detectAssistantTranscriptRoleHeaderText(text);
  if (!roleDetection) {
    return;
  }
  const provider = normalizeOptionalString((assistantMessage as { provider?: unknown }).provider);
  const model = normalizeOptionalString((assistantMessage as { model?: unknown }).model);
  const sessionId = normalizeOptionalString((ctx.params.session as { id?: unknown }).id);
  ctx.log.warn(
    "Assistant reply contains transcript-role-looking text; treating it as inert assistant text.",
    {
      runId: ctx.params.runId,
      ...(sessionId ? { sessionId } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      pattern: roleDetection.kind,
      role: roleDetection.role,
    },
  );
}
