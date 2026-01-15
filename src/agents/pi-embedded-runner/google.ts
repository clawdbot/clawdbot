import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import { registerUnhandledRejectionHandler } from "../../infra/unhandled-rejections.js";
import {
  downgradeGeminiThinkingBlocks,
  downgradeGeminiHistory,
  isCompactionFailureError,
  isGoogleModelApi,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "../pi-embedded-helpers.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { log } from "./logger.js";
import { describeUnknownError } from "./utils.js";
import { isAntigravityClaude } from "../pi-embedded-helpers/google.js";

const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
const GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
const OPENAI_TOOL_CALL_ID_APIS = new Set([
  "openai",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);

function shouldSanitizeToolCallIds(modelApi?: string | null): boolean {
  if (!modelApi) return false;
  return isGoogleModelApi(modelApi) || OPENAI_TOOL_CALL_ID_APIS.has(modelApi);
}

function findUnsupportedSchemaKeywords(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findUnsupportedSchemaKeywords(item, `${path}[${index}]`),
    );
  }
  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS.has(key)) {
      violations.push(`${path}.${key}`);
    }
    if (value && typeof value === "object") {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.${key}`));
    }
  }
  return violations;
}

export function logToolSchemasForGoogle(params: { tools: AgentTool[]; provider: string }) {
  if (params.provider !== "google-antigravity" && params.provider !== "google-gemini-cli") {
    return;
  }
  const toolNames = params.tools.map((tool, index) => `${index}:${tool.name}`);
  log.info("google tool schema snapshot", {
    provider: params.provider,
    toolCount: params.tools.length,
    tools: toolNames,
  });
  for (const [index, tool] of params.tools.entries()) {
    const violations = findUnsupportedSchemaKeywords(tool.parameters, `${tool.name}.parameters`);
    if (violations.length > 0) {
      log.warn("google tool schema has unsupported keywords", {
        index,
        tool: tool.name,
        violations: violations.slice(0, 12),
        violationCount: violations.length,
      });
    }
  }
}

registerUnhandledRejectionHandler((reason) => {
  const message = describeUnknownError(reason);
  if (!isCompactionFailureError(message)) return false;
  log.error(`Auto-compaction failed (unhandled): ${message}`);
  return true;
});

type CustomEntryLike = { type?: unknown; customType?: unknown };

function hasGoogleTurnOrderingMarker(sessionManager: SessionManager): boolean {
  try {
    return sessionManager
      .getEntries()
      .some(
        (entry) =>
          (entry as CustomEntryLike)?.type === "custom" &&
          (entry as CustomEntryLike)?.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE,
      );
  } catch {
    return false;
  }
}

function markGoogleTurnOrderingMarker(sessionManager: SessionManager): void {
  try {
    sessionManager.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
      timestamp: Date.now(),
    });
  } catch {
    // ignore marker persistence failures
  }
}

export function applyGoogleTurnOrderingFix(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  sessionManager: SessionManager;
  sessionId: string;
  warn?: (message: string) => void;
}): { messages: AgentMessage[]; didPrepend: boolean } {
  if (!isGoogleModelApi(params.modelApi)) {
    return { messages: params.messages, didPrepend: false };
  }
  const first = params.messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (first?.role !== "assistant") {
    return { messages: params.messages, didPrepend: false };
  }
  const sanitized = sanitizeGoogleTurnOrdering(params.messages);
  const didPrepend = sanitized !== params.messages;
  if (didPrepend && !hasGoogleTurnOrderingMarker(params.sessionManager)) {
    const warn = params.warn ?? ((message: string) => log.warn(message));
    warn(`google turn ordering fixup: prepended user bootstrap (sessionId=${params.sessionId})`);
    markGoogleTurnOrderingMarker(params.sessionManager);
  }
  return { messages: sanitized, didPrepend };
}

export async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  modelId?: string;
  sessionManager: SessionManager;
  sessionId: string;
}): Promise<AgentMessage[]> {
  const sanitizedImages = await sanitizeSessionMessagesImages(params.messages, "session:history", {
    sanitizeToolCallIds: shouldSanitizeToolCallIds(params.modelApi),
    enforceToolCallLast: params.modelApi === "anthropic-messages",
    preserveSignatures: params.modelApi === "google-antigravity" && isAntigravityClaude(params.modelId),
  });
  const repairedTools = sanitizeToolUseResultPairing(sanitizedImages);
  // Gemini rejects unsigned thinking blocks; downgrade them before send to avoid INVALID_ARGUMENT.
  const downgradedThinking = isGoogleModelApi(params.modelApi)
    ? downgradeGeminiThinkingBlocks(repairedTools)
    : repairedTools;
  // Downgrade Gemini history for native Gemini APIs, but NOT for Antigravity Claude
  const downgraded = isGoogleModelApi(params.modelApi) && !isAntigravityClaude(params.modelId)
    ? downgradeGeminiHistory(downgradedThinking)
    : downgradedThinking;

  return applyGoogleTurnOrderingFix({
    messages: downgraded,
    modelApi: params.modelApi,
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
  }).messages;
}
