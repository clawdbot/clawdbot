import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import { registerUnhandledRejectionHandler } from "../../infra/unhandled-rejections.js";
import {
  isCompactionFailureError,
  isGoogleModelApi,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "../pi-embedded-helpers.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { log } from "./logger.js";
import { describeUnknownError } from "./utils.js";
import { isAntigravityClaude } from "../pi-embedded-helpers/google.js";
import { cleanToolSchemaForGemini } from "../pi-tools.schema.js";
import { normalizeProviderId } from "../model-selection.js";
import type { ToolCallIdMode } from "../tool-call-id.js";

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
const MISTRAL_MODEL_HINTS = [
  "mistral",
  "mixtral",
  "codestral",
  "pixtral",
  "devstral",
  "ministral",
  "mistralai",
];
const ANTIGRAVITY_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidAntigravitySignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length % 4 !== 0) return false;
  return ANTIGRAVITY_SIGNATURE_RE.test(trimmed);
}

function shouldSanitizeToolCallIds(modelApi?: string | null): boolean {
  if (!modelApi) return false;
  return isGoogleModelApi(modelApi);
}

function isMistralModel(params: { provider?: string | null; modelId?: string | null }): boolean {
  const provider = normalizeProviderId(params.provider ?? "");
  if (provider === "mistral") return true;
  const modelId = (params.modelId ?? "").toLowerCase();
  if (!modelId) return false;
  return MISTRAL_MODEL_HINTS.some((hint) => modelId.includes(hint));
}

function sanitizeAntigravityThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistant.content)) {
      out.push(msg);
      continue;
    }
    type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
    const nextContent: AssistantContentBlock[] = [];
    let contentChanged = false;
    for (const block of assistant.content) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "thinking"
      ) {
        nextContent.push(block);
        continue;
      }
      const rec = block as {
        thinkingSignature?: unknown;
        signature?: unknown;
        thought_signature?: unknown;
        thoughtSignature?: unknown;
      };
      const candidate =
        rec.thinkingSignature ?? rec.signature ?? rec.thought_signature ?? rec.thoughtSignature;
      if (!isValidAntigravitySignature(candidate)) {
        contentChanged = true;
        continue;
      }
      if (rec.thinkingSignature !== candidate) {
        const nextBlock = {
          ...(block as unknown as Record<string, unknown>),
          thinkingSignature: candidate,
        } as AssistantContentBlock;
        nextContent.push(nextBlock);
        contentChanged = true;
      } else {
        nextContent.push(block);
      }
    }
    if (contentChanged) {
      touched = true;
    }
    if (nextContent.length === 0) {
      touched = true;
      continue;
    }
    out.push(contentChanged ? { ...assistant, content: nextContent } : msg);
  }
  return touched ? out : messages;
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
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") continue;
    if (GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS.has(key)) {
      violations.push(`${path}.${key}`);
    }
    if (value && typeof value === "object") {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.${key}`));
    }
  }
  return violations;
}

export function sanitizeToolsForGoogle<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
}): AgentTool<TSchemaType, TResult>[] {
  if (params.provider !== "google-antigravity" && params.provider !== "google-gemini-cli") {
    return params.tools;
  }
  return params.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") return tool;
    return {
      ...tool,
      parameters: cleanToolSchemaForGemini(
        tool.parameters as Record<string, unknown>,
      ) as TSchemaType,
    };
  });
}

export function logToolSchemasForGoogle(params: { tools: AgentTool[]; provider: string }) {
  if (params.provider !== "google-antigravity" && params.provider !== "google-gemini-cli") {
    return;
  }
  const toolNames = params.tools.map((tool, index) => `${index}:${tool.name}`);
  const tools = sanitizeToolsForGoogle(params);
  log.info("google tool schema snapshot", {
    provider: params.provider,
    toolCount: tools.length,
    tools: toolNames,
  });
  for (const [index, tool] of tools.entries()) {
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
  provider?: string;
  sessionManager: SessionManager;
  sessionId: string;
}): Promise<AgentMessage[]> {
  const isAntigravityClaudeModel = isAntigravityClaude({
    api: params.modelApi,
    provider: params.provider,
    modelId: params.modelId,
  });
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = (params.modelId ?? "").toLowerCase();
  const isOpenRouterGemini =
    (provider === "openrouter" || provider === "opencode") && modelId.includes("gemini");
  const isMistral = isMistralModel({ provider, modelId });
  const toolCallIdMode: ToolCallIdMode | undefined = isMistral ? "strict9" : undefined;
  const sanitizeToolCallIds = shouldSanitizeToolCallIds(params.modelApi) || isMistral;
  const sanitizedImages = await sanitizeSessionMessagesImages(params.messages, "session:history", {
    sanitizeToolCallIds,
    toolCallIdMode,
    enforceToolCallLast: params.modelApi === "anthropic-messages",
    preserveSignatures: isAntigravityClaudeModel,
    sanitizeThoughtSignatures: isOpenRouterGemini
      ? { allowBase64Only: true, includeCamelCase: true }
      : undefined,
  });
  const sanitizedThinking = isAntigravityClaudeModel
    ? sanitizeAntigravityThinkingBlocks(sanitizedImages)
    : sanitizedImages;
  const repairedTools = sanitizeToolUseResultPairing(sanitizedThinking);

  return applyGoogleTurnOrderingFix({
    messages: repairedTools,
    modelApi: params.modelApi,
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
  }).messages;
}
