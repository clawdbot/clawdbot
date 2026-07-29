/** Agent tools for addressing external conversations independently from local model sessions. */
import crypto from "node:crypto";
import { Type } from "typebox";
// Keep Gateway wire schemas as the single owner so Code Mode never advertises a divergent shape.
import {
  ConversationListResultSchema,
  ConversationSendResultSchema,
  ConversationTurnResultSchema,
  type ConversationListResult,
  type ConversationSendResult,
  type ConversationTurnResult,
} from "../../../packages/gateway-protocol/src/schema/agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";

const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;

const ConversationsListSchema = Type.Object(
  {
    channel: Type.Optional(Type.String({ minLength: 1 })),
    query: Type.Optional(Type.String({ minLength: 1 })),
    limit: optionalPositiveIntegerSchema(),
  },
  { additionalProperties: false },
);

const ConversationsSendSchema = Type.Object(
  {
    conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN.source }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const ConversationsTurnSchema = Type.Object(
  {
    conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN.source }),
    message: Type.String({ minLength: 1 }),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
  },
  { additionalProperties: false },
);

type ConversationToolOptions = {
  agentId?: string;
  agentSessionId?: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
  senderIsOwner?: boolean;
};

type ConversationToolDeps = {
  callGateway: typeof callGateway;
};

const defaultDeps: ConversationToolDeps = {
  callGateway,
};

function resolveToolAgentId(options: ConversationToolOptions): string {
  return options.agentId ?? resolveAgentIdFromSessionKey(options.agentSessionKey);
}

function requireOwner(options: ConversationToolOptions): void {
  if (options.senderIsOwner === false) {
    throw new ToolAuthorizationError("Conversation tools require owner access");
  }
}

function readConversationRef(value: string): string {
  const conversationRef = value.trim().toLowerCase();
  if (!CONVERSATION_REF_PATTERN.test(conversationRef)) {
    throw new ToolInputError(`Invalid conversationRef: ${value}`);
  }
  return conversationRef;
}

function buildConversationOperationId(params: {
  options: ConversationToolOptions;
  toolCallId: string;
  toolName: "conversations_send" | "conversations_turn";
  conversationRef: string;
}): string {
  const identity = [
    resolveToolAgentId(params.options),
    params.options.agentSessionId ?? "",
    params.options.agentSessionKey ?? "",
    params.toolName,
    params.toolCallId,
    params.conversationRef,
  ].join("\u0000");
  return `convop_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

/** Lists opaque, exact external addresses owned by the active agent. */
export function createConversationsListTool(
  options: ConversationToolOptions = {},
  deps: ConversationToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    label: "Conversations",
    name: "conversations_list",
    displaySummary: "List exact external conversation addresses.",
    description:
      "List external conversations as stable conversationRef values. Sessions hold local model context; conversationRef selects an exact external channel destination.",
    parameters: ConversationsListSchema,
    outputSchema: ConversationListResultSchema,
    execute: async (_toolCallId, args) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const limit = Math.min(readPositiveIntegerParam(params, "limit") ?? 50, 100);
      const channel = readStringParam(params, "channel");
      const query = readStringParam(params, "query");
      const result = await deps.callGateway<ConversationListResult>({
        method: "conversations.list",
        params: {
          agentId: resolveToolAgentId(options),
          limit,
          ...(channel ? { channel } : {}),
          ...(query ? { query } : {}),
        },
        ...(options.config ? { config: options.config } : {}),
      });
      return jsonResult(result);
    },
  };
}

/** Sends directly to one external conversation without invoking its backing local session. */
export function createConversationsSendTool(
  options: ConversationToolOptions = {},
  deps: ConversationToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    label: "Conversation Send",
    name: "conversations_send",
    displaySummary: "Send to an exact external conversation.",
    description:
      "Send directly through a conversationRef from conversations_list. This performs channel delivery; it does not run the local agent in the backing session.",
    parameters: ConversationsSendSchema,
    outputSchema: ConversationSendResultSchema,
    execute: async (toolCallId, args, signal) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const conversationRef = readConversationRef(
        readStringParam(params, "conversationRef", { required: true }),
      );
      const message = readStringParam(params, "message", { required: true });
      const operationId = buildConversationOperationId({
        options,
        toolCallId,
        toolName: "conversations_send",
        conversationRef,
      });
      const result = await deps.callGateway<ConversationSendResult>({
        method: "conversations.send",
        params: {
          agentId: resolveToolAgentId(options),
          ...(options.agentSessionKey ? { sourceSessionKey: options.agentSessionKey } : {}),
          operationId,
          conversationRef,
          message,
        },
        ...(options.config ? { config: options.config } : {}),
        ...(signal ? { signal } : {}),
      });
      return jsonResult(result);
    },
  };
}

/** Sends and consumes one correlated peer reply inline, preserving both sides in the transcript. */
export function createConversationsTurnTool(
  options: ConversationToolOptions = {},
  deps: ConversationToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    label: "Conversation Turn",
    name: "conversations_turn",
    displaySummary: "Send and wait for the correlated peer reply.",
    description:
      "Send through a conversationRef and wait for its correlated inbound reply. The reply returns here instead of starting a second local agent turn; unsolicited messages still start normal turns.",
    parameters: ConversationsTurnSchema,
    outputSchema: ConversationTurnResultSchema,
    execute: async (toolCallId, args, signal) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const conversationRef = readConversationRef(
        readStringParam(params, "conversationRef", { required: true }),
      );
      const message = readStringParam(params, "message", { required: true });
      const timeoutSeconds = readPositiveIntegerParam(params, "timeoutSeconds") ?? 30;
      const timeoutMs = timeoutSeconds * 1_000;
      const agentId = resolveToolAgentId(options);
      const turnId = buildConversationOperationId({
        options,
        toolCallId,
        toolName: "conversations_turn",
        conversationRef,
      });
      const result = await deps.callGateway<ConversationTurnResult>({
        method: "conversations.turn",
        params: {
          agentId,
          ...(options.agentSessionKey ? { sourceSessionKey: options.agentSessionKey } : {}),
          turnId,
          conversationRef,
          message,
          timeoutMs,
        },
        ...(options.config ? { config: options.config } : {}),
        timeoutMs: timeoutMs + 20_000,
        ...(signal ? { signal } : {}),
        onSignalAbort: async (request) => {
          await request("conversations.turn.cancel", { agentId, turnId }, { timeoutMs: 5_000 });
        },
      });
      return jsonResult(result);
    },
  };
}
