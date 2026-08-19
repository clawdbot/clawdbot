import {
  ErrorCodes,
  errorShape,
  validateProgressCardGetParams,
  validateProgressCardPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeProgressCardInput,
  PROGRESS_CARD_MAX_STEP_UTF8_BYTES,
  PROGRESS_CARD_MAX_STEPS,
  PROGRESS_CARD_MAX_UTF8_BYTES,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import { progressCardStore, type ProgressCardStore } from "../progress-card-store.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export { PROGRESS_CARD_MAX_STEP_UTF8_BYTES, PROGRESS_CARD_MAX_STEPS, PROGRESS_CARD_MAX_UTF8_BYTES };

function resolveProgressCardSessionKey(
  sessionKey: string,
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): string | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, sessionKey, undefined);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  const canonicalKey = resolveSessionStoreKey({
    cfg,
    sessionKey,
    storeAgentId: requested.agentId,
  });
  return sessionObserverScopeKey(canonicalKey, requested.agentId);
}

export function createProgressCardHandlers(
  store: ProgressCardStore = progressCardStore,
): GatewayRequestHandlers {
  return {
    "progressCard.get": ({ params, respond, context }) => {
      if (!assertValidParams(params, validateProgressCardGetParams, "progressCard.get", respond)) {
        return;
      }
      const sessionKey = resolveProgressCardSessionKey(params.sessionKey, context, respond);
      if (!sessionKey) {
        return;
      }
      try {
        respond(true, { card: store.get(sessionKey) }, undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "progressCard.put": ({ params, respond, context }) => {
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
      const sessionKey = resolveProgressCardSessionKey(params.sessionKey, context, respond);
      if (!sessionKey) {
        return;
      }
      try {
        const result = store.put(sessionKey, {
          ...input,
          expectedRevision: params.expectedRevision,
        });
        if (params.expectedRevision === undefined || result.card === null) {
          context.broadcast("progressCard.changed", {
            sessionKey,
            revision: result.card?.revision ?? null,
          });
        }
        respond(true, result, undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
  };
}

export const progressCardHandlers = createProgressCardHandlers();
