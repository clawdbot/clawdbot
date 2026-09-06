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
import {
  resolveConversation,
  resolveConversationRegistryScope,
  type ConversationRecord,
} from "../../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveMessageToolsConfig } from "../../infra/outbound/outbound-policy.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  textResult,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  buildTurnSendLedgerSessionKey,
  buildTurnSendTargetKey,
  commitTurnSend,
  releaseTurnSend,
  reserveTurnSend,
} from "./turn-send-ledger.js";

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
  /** Current agent run; scopes the per-turn send ledger to one turn. */
  runId?: string;
  config?: OpenClawConfig;
  senderIsOwner?: boolean;
};

type ConversationToolDeps = {
  callGateway: AgentToolGatewayRequestCaller;
  resolveConversation: typeof resolveConversation;
};

const defaultDeps: ConversationToolDeps = {
  callGateway: callAgentToolGatewayRequest,
  resolveConversation,
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
      const channel = readToolStringParam(params, "channel");
      const query = readToolStringParam(params, "query");
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

function resolveConversationBudgetContext(
  options: ConversationToolOptions,
  deps: ConversationToolDeps,
  conversationRef: string,
): { sessionKey: string; runId: string; targetKey: string; channel: string } | undefined {
  // Scope the ledger by the same agent-prefixed session slot the message tool uses
  // (buildTurnSendLedgerSessionKey), not the raw session key: keying one tool raw and
  // the other agent-prefixed splits one turn across two slots and lets alternating the
  // tools evade the nudge and hard cap. This only changes the ledger slot key; the raw
  // agentSessionKey still flows unchanged to the Gateway sourceSessionKey and operationId.
  const ledgerSessionKey = buildTurnSendLedgerSessionKey(
    resolveToolAgentId(options),
    options.agentSessionKey,
  );
  if (!ledgerSessionKey || !options.runId || !options.config) {
    return undefined;
  }
  // Resolve the opaque ref to its real (channel, account, target) route via the local
  // registry so the ledger key matches the message tool's key for the same recipient;
  // alternating the two tools at one peer must not evade the nudge or hard cap. Fail
  // open on any miss — a registry read that comes up empty (or throws) must never
  // block a send, mirroring resolveOutboundActionRoute returning undefined on ambiguity.
  let record: ConversationRecord | undefined;
  try {
    record = deps.resolveConversation(
      resolveConversationRegistryScope({
        agentId: resolveToolAgentId(options),
        config: options.config,
      }),
      conversationRef,
    );
  } catch {
    return undefined;
  }
  if (!record) {
    return undefined;
  }
  return {
    sessionKey: ledgerSessionKey,
    runId: options.runId,
    targetKey: buildTurnSendTargetKey({
      channel: record.channel,
      accountId: record.accountId,
      target: record.target,
    }),
    // The resolved channel, reused for a schema-valid suppressed result below so the
    // capped path does not have to re-read the registry to satisfy the send contract.
    channel: record.channel,
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
      "Send directly through a conversationRef. This performs channel delivery; it does not run the local agent in the backing session.",
    parameters: ConversationsSendSchema,
    outputSchema: ConversationSendResultSchema,
    execute: async (toolCallId, args, signal) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const conversationRef = readConversationRef(
        readToolStringParam(params, "conversationRef", { required: true }),
      );
      const message = readToolStringParam(params, "message", { required: true });
      const operationId = buildConversationOperationId({
        options,
        toolCallId,
        toolName: "conversations_send",
        conversationRef,
      });
      // Per-turn send budget, shared with the message tool: count successful sends
      // per (turn, resolved route) so a reworded resend to the same conversation is
      // visible even though the loop detector hashes full params and can't see it.
      // The ref is resolved to its (channel, account, target) route so the ledger key
      // is identical to the message tool's for the same recipient.
      const budgetContext = resolveConversationBudgetContext(options, deps, conversationRef);
      // Reserve one send before the Gateway call so a concurrent same-target send cannot
      // slip past a positive cap while this one is in flight. The reserve is keyed by the
      // operationId: an idempotent replay (the same toolCallId retried) resolves to the
      // same operationId, so it is admitted past the cap (`replay`) — the Gateway returns
      // the completed operation as "sent" without re-delivering
      // (conversation-send.ts resultForCompletedOperation) and settle is skipped so the
      // count and nudge stay put. The hard cap (opt-in via
      // tools.message.maxMessagesPerTurnPerTarget) is enforced by the `exhausted` result.
      const maxPerTurn =
        budgetContext && options.config
          ? resolveEffectiveMessageToolsConfig({
              cfg: options.config,
              agentId: resolveToolAgentId(options),
            })?.maxMessagesPerTurnPerTarget
          : undefined;
      const reservation = budgetContext
        ? reserveTurnSend(budgetContext, { maxPerTurn, operationId })
        : undefined;
      if (reservation?.status === "exhausted" && budgetContext) {
        // conversations_send declares the closed ConversationSendResultSchema, so
        // the details must stay within it (status/conversationRef/channel). The
        // human-readable block reason rides in the text content, not details, or
        // Code Mode's output-schema check (assertCatalogOutputMatchesSchema) throws.
        return textResult(
          `Blocked: already sent ${maxPerTurn} message(s) to this conversation this turn (maxMessagesPerTurnPerTarget). Finalize your reply instead of sending another message.`,
          {
            status: "suppressed" as const,
            conversationRef,
            channel: budgetContext.channel,
          },
        );
      }
      let result: ConversationSendResult;
      try {
        result = await deps.callGateway<ConversationSendResult>({
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
      } catch (error) {
        // Nothing reached the peer: roll back the reservation so a throwing send does
        // not consume the cap. A `replay` reservation took no pending slot, so this is
        // a no-op for it.
        if (reservation?.status === "reserved") {
          releaseTurnSend(reservation.reservation);
        }
        throw error;
      }
      const base = jsonResult(result);
      // Settle the reservation against the outcome. Only a confirmed "sent" commits;
      // "queued" (enqueue-only, unconfirmed), "suppressed", and "unknown" have not
      // reached the peer, so they release the reservation and draw no nudge. This
      // matches the delivery owner's confirmed-delivery definition and the message
      // tool (which has no "queued" concept). A `replay` reservation is left unsettled
      // (the Gateway deduped it to the completed receipt), so it neither re-commits nor
      // nudges. The soft reminder fires from the second committed send onward unless
      // turnSendNudge is explicitly disabled.
      if (reservation?.status === "reserved") {
        if (result.status !== "sent") {
          releaseTurnSend(reservation.reservation);
        } else {
          const sendCount = commitTurnSend(reservation.reservation);
          const nudgeEnabled =
            !options.config ||
            resolveEffectiveMessageToolsConfig({
              cfg: options.config,
              agentId: resolveToolAgentId(options),
            })?.turnSendNudge !== false;
          if (sendCount >= 2 && nudgeEnabled) {
            return {
              ...base,
              content: [
                ...base.content,
                {
                  type: "text" as const,
                  text: `You have already sent ${sendCount} messages to this conversation this turn; if this is a rewrite of the same reply, finalize now instead of sending another variant.`,
                },
              ],
            };
          }
        }
      }
      return base;
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
        readToolStringParam(params, "conversationRef", { required: true }),
      );
      const message = readToolStringParam(params, "message", { required: true });
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
