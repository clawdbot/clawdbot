import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConversationListParams,
  validateConversationSendParams,
  validateConversationTurnCancelParams,
  validateConversationTurnParams,
  type ConversationListParams,
  type ConversationSendParams,
  type ConversationTurnCancelParams,
  type ConversationTurnParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { cancelPendingConversationTurn } from "../../sessions/conversation-turns.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "../conversation-errors.js";
import { runGatewayConversationList } from "../conversation-list.js";
import { runGatewayConversationSend } from "../conversation-send.js";
import { runGatewayConversationTurn } from "../conversation-turn.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import { formatForLog } from "../ws-log.js";
import {
  cacheGatewayDedupeResult,
  resolveGatewayInflightRequest,
  runGatewayInflightWork,
  type GatewayInflightResult,
} from "./inflight.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

type ConversationHandlerDeps = {
  cancelConversationTurn: typeof cancelPendingConversationTurn;
  runConversationList: typeof runGatewayConversationList;
  runConversationSend: typeof runGatewayConversationSend;
  runConversationTurn: typeof runGatewayConversationTurn;
};

function isAuthenticatedOwner(client: GatewayClient | null): boolean {
  // These RPCs require operator.admin. Derive owner status from the admitted
  // socket anyway so no future schema field can self-assert channel authority.
  return client?.connect?.scopes?.includes(ADMIN_SCOPE) === true;
}

function conversationOperationKey(params: {
  method: "send" | "turn";
  agentId: string;
  operationId: string;
}): string {
  // Delivery state is agent-scoped, so Gateway replay and in-flight joins must
  // use the same namespace. Otherwise equal client operation IDs cross agents.
  return `conversations.${params.method}:${JSON.stringify([params.agentId, params.operationId])}`;
}

function bindConversationOperationIdentity(
  context: GatewayRequestContext,
  request: {
    method: "send" | "turn";
    operationId: string;
    agentId: string;
    sourceSessionKey?: string;
    conversationRef: string;
    message: string;
    timeoutMs?: number;
  },
): string | null {
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        request.agentId,
        request.sourceSessionKey ?? null,
        request.conversationRef,
        request.message,
        request.timeoutMs ?? null,
      ]),
    )
    .digest("hex");
  const operationKey = conversationOperationKey(request);
  const identityKey = `${operationKey}:identity`;
  const completed = context.dedupe.get(operationKey);
  if (completed && completed.requestIdentity !== identity) {
    return null;
  }
  const prior = context.dedupe.get(identityKey);
  if (prior) {
    if (!prior.ok || prior.requestIdentity !== identity) {
      return null;
    }
    context.dedupe.set(identityKey, { ...prior, ts: Date.now() });
    return identity;
  }
  // Share the Gateway's bounded, TTL-pruned dedupe store so identity claims
  // cover in-flight work without creating another unbounded lifecycle.
  context.dedupe.set(identityKey, { ts: Date.now(), ok: true, requestIdentity: identity });
  return identity;
}

function releaseConversationOperationIdentity(params: {
  context: GatewayRequestContext;
  operationKey: string;
  requestIdentity: string;
}): void {
  const identityKey = `${params.operationKey}:identity`;
  if (params.context.dedupe.get(identityKey)?.requestIdentity === params.requestIdentity) {
    params.context.dedupe.delete(identityKey);
  }
}

async function runConversationOperation<T extends { channel: string }>(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  dedupeKey: string;
  operationId: string;
  requestIdentity: string;
  execute: () => Promise<T>;
}): Promise<void> {
  const inflight = resolveGatewayInflightRequest({
    context: params.context,
    dedupeKey: params.dedupeKey,
    idempotencyKey: params.operationId,
    respond: params.respond,
  });
  if (inflight.kind === "handled") {
    await inflight.done;
    return;
  }
  const { dedupeKey, inflightMap } = inflight;
  let releaseRequestIdentity = false;
  const work = (async (): Promise<GatewayInflightResult> => {
    try {
      const payload = await params.execute();
      const result: GatewayInflightResult = {
        ok: true,
        payload,
        meta: { channel: payload.channel },
      };
      cacheGatewayDedupeResult({
        context: params.context,
        dedupeKey,
        requestIdentity: params.requestIdentity,
        result,
      });
      return result;
    } catch (cause) {
      const isTerminalInputError = cause instanceof ConversationInputError;
      const isOperationConflict = cause instanceof ConversationOperationConflictError;
      const error = errorShape(
        isTerminalInputError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        cause instanceof Error ? cause.message : String(cause),
      );
      const result: GatewayInflightResult = {
        ok: false,
        error,
        meta: { error: formatForLog(cause) },
      };
      if (isOperationConflict) {
        releaseRequestIdentity = true;
      } else if (isTerminalInputError) {
        cacheGatewayDedupeResult({
          context: params.context,
          dedupeKey,
          requestIdentity: params.requestIdentity,
          result,
        });
      }
      return result;
    }
  })();
  try {
    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond: params.respond });
  } finally {
    if (releaseRequestIdentity) {
      // The durable row belongs to another request. Release this speculative
      // claim after in-flight joins drain so its authoritative identity can retry.
      releaseConversationOperationIdentity({
        context: params.context,
        operationKey: dedupeKey,
        requestIdentity: params.requestIdentity,
      });
    }
  }
}

const defaultConversationHandlerDeps: ConversationHandlerDeps = {
  cancelConversationTurn: cancelPendingConversationTurn,
  runConversationList: runGatewayConversationList,
  runConversationSend: runGatewayConversationSend,
  runConversationTurn: runGatewayConversationTurn,
};

export function createConversationHandlers(
  overrides: Partial<ConversationHandlerDeps> = {},
): GatewayRequestHandlers {
  const deps = { ...defaultConversationHandlerDeps, ...overrides };
  return {
    "conversations.list": async ({ params, respond, context }) => {
      if (!validateConversationListParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid conversations.list params: ${formatValidationErrors(validateConversationListParams.errors)}`,
          ),
        );
        return;
      }
      const request = params as ConversationListParams;
      try {
        respond(
          true,
          await deps.runConversationList({
            config: resolveGatewayPluginConfig({ config: context.getRuntimeConfig() }),
            agentId: request.agentId,
            ...(request.channel ? { channel: request.channel } : {}),
            ...(request.query ? { query: request.query } : {}),
            limit: request.limit ?? 50,
          }),
          undefined,
        );
      } catch (cause) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
      }
    },
    "conversations.send": async ({ params, respond, context, client }) => {
      if (!validateConversationSendParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid conversations.send params: ${formatValidationErrors(validateConversationSendParams.errors)}`,
          ),
        );
        return;
      }
      const request = params as ConversationSendParams;
      const requestIdentity = bindConversationOperationIdentity(context, {
        method: "send",
        operationId: request.operationId,
        agentId: request.agentId,
        ...(request.sourceSessionKey ? { sourceSessionKey: request.sourceSessionKey } : {}),
        conversationRef: request.conversationRef,
        message: request.message,
      });
      if (!requestIdentity) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `conversation send ${request.operationId} was already used with different input`,
          ),
        );
        return;
      }
      await runConversationOperation({
        context,
        dedupeKey: conversationOperationKey({
          method: "send",
          agentId: request.agentId,
          operationId: request.operationId,
        }),
        operationId: request.operationId,
        requestIdentity,
        respond,
        execute: async () =>
          await deps.runConversationSend({
            config: resolveGatewayPluginConfig({ config: context.getRuntimeConfig() }),
            agentId: request.agentId,
            senderIsOwner: isAuthenticatedOwner(client),
            ...(request.sourceSessionKey ? { sourceSessionKey: request.sourceSessionKey } : {}),
            operationId: request.operationId,
            conversationRef: request.conversationRef,
            message: request.message,
          }),
      });
    },
    "conversations.turn.cancel": ({ params, respond }) => {
      if (!validateConversationTurnCancelParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid conversations.turn.cancel params: ${formatValidationErrors(validateConversationTurnCancelParams.errors)}`,
          ),
        );
        return;
      }
      const request = params as ConversationTurnCancelParams;
      respond(
        true,
        {
          cancelled: deps.cancelConversationTurn({
            agentId: request.agentId,
            id: request.turnId,
          }),
        },
        undefined,
      );
    },
    "conversations.turn": async ({ params, respond, context, client }) => {
      if (!validateConversationTurnParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid conversations.turn params: ${formatValidationErrors(validateConversationTurnParams.errors)}`,
          ),
        );
        return;
      }
      const request = params as ConversationTurnParams;
      const requestIdentity = bindConversationOperationIdentity(context, {
        method: "turn",
        operationId: request.turnId,
        agentId: request.agentId,
        ...(request.sourceSessionKey ? { sourceSessionKey: request.sourceSessionKey } : {}),
        conversationRef: request.conversationRef,
        message: request.message,
        timeoutMs: request.timeoutMs,
      });
      if (!requestIdentity) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `conversation turn ${request.turnId} was already used with different input`,
          ),
        );
        return;
      }
      await runConversationOperation({
        context,
        dedupeKey: conversationOperationKey({
          method: "turn",
          agentId: request.agentId,
          operationId: request.turnId,
        }),
        operationId: request.turnId,
        requestIdentity,
        respond,
        execute: async () =>
          await deps.runConversationTurn({
            config: resolveGatewayPluginConfig({ config: context.getRuntimeConfig() }),
            agentId: request.agentId,
            senderIsOwner: isAuthenticatedOwner(client),
            ...(request.sourceSessionKey ? { sourceSessionKey: request.sourceSessionKey } : {}),
            turnId: request.turnId,
            conversationRef: request.conversationRef,
            message: request.message,
            timeoutMs: request.timeoutMs,
          }),
      });
    },
  };
}

export const conversationHandlers = createConversationHandlers();
