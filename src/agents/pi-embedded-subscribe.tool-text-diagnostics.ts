import type { AssistantMessage } from "@mariozechner/pi-ai";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { detectToolCallShapedText } from "../shared/text/tool-call-shaped-text.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { normalizeToolName } from "./tool-policy.js";

function hasStructuredToolInvocation(message: AssistantMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as unknown as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.trim() : "";
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
    return Array.isArray(record.tool_calls) || Array.isArray(record.toolCalls);
  });
}

function extractAssistantTextForToolDiagnostics(message: AssistantMessage): string {
  return (
    extractTextFromChatContent(message.content, {
      joinWith: "\n",
      normalizeText: (text) => text.trim(),
    }) ?? ""
  );
}

function isRegisteredToolName(
  toolName: string | undefined,
  registeredToolNames: ReadonlySet<string> | undefined,
): boolean | undefined {
  if (!toolName || !registeredToolNames) {
    return undefined;
  }
  const normalized = normalizeToolName(toolName);
  for (const registeredToolName of registeredToolNames) {
    if (normalizeToolName(registeredToolName) === normalized) {
      return true;
    }
  }
  return false;
}

export function warnIfAssistantEmittedToolText(
  ctx: EmbeddedPiSubscribeContext,
  assistantMessage: AssistantMessage,
) {
  if (hasStructuredToolInvocation(assistantMessage)) {
    return;
  }
  const detection = detectToolCallShapedText(
    extractAssistantTextForToolDiagnostics(assistantMessage),
  );
  if (!detection) {
    return;
  }
  const provider = normalizeOptionalString((assistantMessage as { provider?: unknown }).provider);
  const model = normalizeOptionalString((assistantMessage as { model?: unknown }).model);
  const registeredTool = isRegisteredToolName(detection.toolName, ctx.builtinToolNames);
  const sessionId = normalizeOptionalString((ctx.params.session as { id?: unknown }).id);
  ctx.log.warn(
    "Assistant reply looks like a tool call, but no structured tool invocation was emitted; treating it as text.",
    {
      runId: ctx.params.runId,
      ...(sessionId ? { sessionId } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      pattern: detection.kind,
      ...(detection.toolName ? { toolName: detection.toolName } : {}),
      ...(registeredTool !== undefined ? { registeredTool } : {}),
    },
  );
}
