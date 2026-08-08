import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  summarizeCloseoutRecord,
  type CloseoutTracker,
  type ConversationSend,
  type ConversationSendResult,
} from "./closeout-tracker.js";

const CloseoutTrackerParams = Type.Object({
  action: Type.Union([
    Type.Literal("send"),
    Type.Literal("reconcile"),
    Type.Literal("complete"),
    Type.Literal("get"),
    Type.Literal("list"),
  ]),
  closeoutId: Type.Optional(Type.String({ maxLength: 128 })),
  conversationRef: Type.Optional(Type.String({ maxLength: 512 })),
  message: Type.Optional(Type.String({ maxLength: 16_000 })),

  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requireParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("closeout tracker parameters must be an object");
  }
  return value as Record<string, unknown>;
}

function listLimit(params: Record<string, unknown>): number {
  const value = params.limit;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return 50;
  }
  return Math.max(1, Math.min(100, value));
}

/** Calls the existing durable Gateway conversation operation; it does not own transport state. */
export function createRuntimeConversationSend(runtime: PluginRuntime): ConversationSend {
  return async (params) =>
    await runtime.gateway.request<ConversationSendResult>("conversations.send", params, {
      scopes: ["operator.admin"],
    });
}

function createCloseoutTrackerTool(params: {
  tracker: CloseoutTracker;
  agentId: string;
  sourceSessionKey?: string;
}): AnyAgentTool {
  return {
    name: "workboard_closeout",
    label: "Workboard Closeout Tracker",
    description:
      "Track and safely reconcile one external closeout. Uses one stable durable send operation; uncertain outcomes are never completed or resent under a new id automatically.",
    parameters: CloseoutTrackerParams,
    async execute(_toolCallId, rawParams) {
      const toolParams = requireParams(rawParams);
      const action = requireString(toolParams, "action");
      if (action === "list") {
        const records = await params.tracker.list(params.agentId, listLimit(toolParams));
        return jsonResult({ closeouts: records.map(summarizeCloseoutRecord) });
      }
      const closeoutId = requireString(toolParams, "closeoutId");
      switch (action) {
        case "send":
          return jsonResult(
            summarizeCloseoutRecord(
              await params.tracker.send({
                closeoutId,
                agentId: params.agentId,
                ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
                conversationRef: requireString(toolParams, "conversationRef"),
                message: requireString(toolParams, "message"),
              }),
            ),
          );
        case "reconcile":
          return jsonResult(
            summarizeCloseoutRecord(await params.tracker.reconcile(params.agentId, closeoutId)),
          );
        case "complete":
          return jsonResult(
            summarizeCloseoutRecord(await params.tracker.complete(params.agentId, closeoutId)),
          );
        case "get": {
          const record = await params.tracker.get(params.agentId, closeoutId);
          return jsonResult({ closeout: record ? summarizeCloseoutRecord(record) : null });
        }
        default:
          throw new Error(`unknown closeout tracker action: ${action}`);
      }
    },
  };
}

export function createCloseoutTrackerToolFactory(params: {
  tracker: CloseoutTracker;
}): OpenClawPluginToolFactory {
  return (context) => {
    if (context.sandboxed || context.senderIsOwner !== true || !context.agentId) {
      return null;
    }
    return createCloseoutTrackerTool({
      tracker: params.tracker,
      agentId: context.agentId,
      ...(context.sessionKey ? { sourceSessionKey: context.sessionKey } : {}),
    });
  };
}
