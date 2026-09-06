import {
  ErrorCodes,
  errorShape,
  validateProgressCardGetParams,
  validateProgressCardPutParams,
  type ProgressCard,
  type ProgressCardGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeProgressCardInput,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import { progressCardStore, type ProgressCardStore } from "../progress-card-store.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveProgressCardSession(
  params: ProgressCardGetParams,
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): { sessionKey: string; agentId: string; scopeKey: string } | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  const canonicalKey = resolveSessionStoreKey({
    cfg,
    sessionKey: params.sessionKey,
    storeAgentId: requested.agentId,
  });
  return {
    sessionKey: canonicalKey,
    agentId: requested.agentId,
    scopeKey: sessionObserverScopeKey(canonicalKey, requested.agentId),
  };
}

function projectProgressCard(card: ProgressCard | null, scopeKey: string): ProgressCard | null {
  // Wire identities distinguish owners; SQLite cards reference the canonical session row.
  return card ? { ...card, sessionKey: scopeKey } : null;
}

export function createProgressCardHandlers(
  store: ProgressCardStore = progressCardStore,
): GatewayRequestHandlers {
  return {
    "progressCard.get": ({ params, respond, context, sessionMutationAuthorization }) => {
      if (!assertValidParams(params, validateProgressCardGetParams, "progressCard.get", respond)) {
        return;
      }
      const session = resolveProgressCardSession(params, context, respond);
      if (!session) {
        return;
      }
      // Lazy handler preparation can outlive the session authorized by the router.
      sessionMutationAuthorization?.assertCurrent();
      try {
        const card = store.get(session.sessionKey, session.agentId);
        respond(true, { card: projectProgressCard(card, session.scopeKey) }, undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "progressCard.put": ({ params, respond, context, sessionMutationAuthorization }) => {
      if (!assertValidParams(params, validateProgressCardPutParams, "progressCard.put", respond)) {
        return;
      }
      let input;
      try {
        input = normalizeProgressCardInput({ markdown: params.markdown, plan: params.plan });
      } catch (error) {
        if (!(error instanceof ProgressCardInputError)) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (params.expectedRevision !== undefined && (input.markdown || input.steps?.length)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "expectedRevision is only valid when clearing a card",
          ),
        );
        return;
      }
      const session = resolveProgressCardSession(params, context, respond);
      if (!session) {
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      try {
        const result = store.put(
          session.sessionKey,
          { ...input, expectedRevision: params.expectedRevision },
          session.agentId,
        );
        if (params.expectedRevision === undefined || result.card === null) {
          context.broadcast(
            "progressCard.changed",
            {
              sessionKey: session.scopeKey,
              revision: result.card?.revision ?? null,
            },
            { sessionKeys: [session.sessionKey], agentId: session.agentId },
          );
        }
        respond(true, { card: projectProgressCard(result.card, session.scopeKey) }, undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
  };
}

export const progressCardHandlers = createProgressCardHandlers();
