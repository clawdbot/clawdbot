import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  cancelStandingIntent,
  createStandingIntent,
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  encodeStandingIntentChannelScope,
  encodeStandingIntentSenderScope,
  listStandingIntents,
  type IntentScope,
  type StandingIntentStatus,
} from "./standing-intents.js";

const INTENT_DESCRIPTION_MAX_CHARS = 500;
const INTENT_KEYWORD_MAX_COUNT = 24;
const INTENT_KEYWORD_MAX_CHARS = 120;
const STANDING_INTENT_AUTOMATION_GUIDANCE =
  "The system injects the reminder automatically when it triggers. Do not deliver it early or cancel it unless the user asks.";
const STANDING_INTENT_SCOPE_GUIDANCE =
  'Use "channel" for any "whenever I mention X" request when channel identity is available. Use "conversation" only when the user explicitly limits the reminder to the current thread. Use "anywhere" when the user asks for it everywhere or the turn has no channel identity.';

type IntentSenderScope = "sender" | "anyone";
type IntentToolParams = {
  action?: unknown;
  id?: unknown;
  description?: unknown;
  triggerKeywords?: unknown;
  scope?: unknown;
  senderScope?: unknown;
  expiresAt?: unknown;
  maxFires?: unknown;
  cooldownSeconds?: unknown;
  status?: unknown;
};

function trimRequiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new Error(`${field} must be at most ${maxChars} characters`);
  }
  return trimmed;
}

function renderArmedIntentMessage(scope: IntentScope): string {
  const scopeDescription =
    scope === "channel"
      ? "for this channel"
      : scope === "conversation"
        ? "for this conversation"
        : "everywhere";
  return `Intent is armed ${scopeDescription}. ${STANDING_INTENT_AUTOMATION_GUIDANCE}`;
}

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("triggerKeywords must be a non-empty string array");
  }
  const normalized = value.map((entry) =>
    trimRequiredString(entry, "triggerKeywords entry", INTENT_KEYWORD_MAX_CHARS).toLowerCase(),
  );
  const unique = [...new Set(normalized)];
  if (unique.length > INTENT_KEYWORD_MAX_COUNT) {
    throw new Error(`triggerKeywords must contain at most ${INTENT_KEYWORD_MAX_COUNT} entries`);
  }
  return unique;
}

function parseExpiry(value: unknown, nowMs: number): number {
  if (value === undefined) {
    return nowMs + DEFAULT_INTENT_EXPIRY_MS;
  }
  if (typeof value !== "string") {
    throw new Error("expiresAt must be an ISO 8601 timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= nowMs) {
    throw new Error("expiresAt must be a future ISO 8601 timestamp");
  }
  return parsed;
}

function parseStatus(value: unknown): StandingIntentStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const statuses: StandingIntentStatus[] = [
    "pending",
    "armed",
    "fired",
    "done",
    "cancelled",
    "expired",
  ];
  if (typeof value !== "string" || !statuses.includes(value as StandingIntentStatus)) {
    throw new Error(`status must be one of: ${statuses.join(", ")}`);
  }
  return value as StandingIntentStatus;
}

function parseScope<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function createStandingIntentTool(options: {
  agentId: string;
  creatorPrincipal: string;
  sourceSessionId?: string;
  conversationId?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
}): AnyAgentTool {
  const defaultScope: IntentScope = options.provider?.trim() ? "channel" : "anywhere";
  const defaultSenderScope: IntentSenderScope =
    options.provider?.trim() && options.senderId?.trim() ? "sender" : "anyone";
  return {
    label: "Standing Intent",
    name: "intent",
    description: `Create, list, or explicitly cancel event-conditioned standing intents. Creating an intent arms it immediately. ${STANDING_INTENT_AUTOMATION_GUIDANCE} ${STANDING_INTENT_SCOPE_GUIDANCE} Use cron or scheduled tasks for time-based reminders; use this tool only for events expressed by trigger keywords.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "cancel"] },
        id: { type: "string" },
        description: { type: "string", maxLength: INTENT_DESCRIPTION_MAX_CHARS },
        triggerKeywords: {
          type: "array",
          items: { type: "string", maxLength: INTENT_KEYWORD_MAX_CHARS },
          maxItems: INTENT_KEYWORD_MAX_COUNT,
        },
        scope: {
          type: "string",
          enum: ["conversation", "channel", "anywhere"],
          default: defaultScope,
          description: STANDING_INTENT_SCOPE_GUIDANCE,
        },
        senderScope: {
          type: "string",
          enum: ["sender", "anyone"],
          default: defaultSenderScope,
        },
        expiresAt: { type: "string" },
        maxFires: { type: "integer", minimum: 1 },
        cooldownSeconds: { type: "integer", minimum: 0 },
        status: {
          type: "string",
          enum: ["pending", "armed", "fired", "done", "cancelled", "expired"],
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, rawParams) => {
      const params = (rawParams ?? {}) as IntentToolParams;
      if (params.action === "create") {
        const nowMs = Date.now();
        const scope = parseScope<IntentScope>(
          params.scope,
          "scope",
          ["conversation", "channel", "anywhere"],
          defaultScope,
        );
        const senderScope = parseScope<IntentSenderScope>(
          params.senderScope,
          "senderScope",
          ["sender", "anyone"],
          defaultSenderScope,
        );
        const intent = createStandingIntent({
          agentId: options.agentId,
          description: trimRequiredString(
            params.description,
            "description",
            INTENT_DESCRIPTION_MAX_CHARS,
          ),
          triggerKeywords: normalizeKeywords(params.triggerKeywords),
          channelScope:
            scope === "anywhere"
              ? null
              : encodeStandingIntentChannelScope({
                  scope,
                  provider: options.provider ?? "",
                  accountId: options.accountId,
                  conversationId: options.conversationId,
                }),
          senderScope:
            senderScope === "anyone"
              ? null
              : encodeStandingIntentSenderScope({
                  provider: options.provider ?? "",
                  accountId: options.accountId,
                  senderId: options.senderId ?? "",
                }),
          creatorSender: options.creatorPrincipal,
          expiresAt: parseExpiry(params.expiresAt, nowMs),
          maxFires: positiveInteger(params.maxFires, "maxFires", DEFAULT_INTENT_MAX_FIRES),
          cooldownSeconds: nonNegativeInteger(
            params.cooldownSeconds,
            "cooldownSeconds",
            DEFAULT_INTENT_COOLDOWN_SECONDS,
          ),
          sourceSessionId: options.sourceSessionId,
          nowMs,
        });
        return jsonResult({ intent, message: renderArmedIntentMessage(scope) });
      }
      if (params.action === "list") {
        return jsonResult({
          intents: listStandingIntents({
            agentId: options.agentId,
            status: parseStatus(params.status),
          }),
        });
      }
      if (params.action === "cancel") {
        const id = trimRequiredString(params.id, "id", 200);
        const intent = cancelStandingIntent({ agentId: options.agentId, id });
        return jsonResult({ cancelled: intent !== null, intent });
      }
      throw new Error("action must be create, list, or cancel");
    },
  };
}
