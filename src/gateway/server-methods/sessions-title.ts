import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsTitlePrepareParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { prepareDashboardSessionTitle } from "../dashboard-session-title.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolveSessionCreateModelSelection } from "../session-create-model-selection.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { resolveRegisteredCatalogCreateTarget } from "./session-catalog.js";
import type { GatewayRequestHandlers } from "./types.js";
import { preparePersonalModelSelection } from "./users-model-account-access.js";
import { assertValidParams } from "./validation.js";

export const sessionTitleHandlers: GatewayRequestHandlers = {
  "sessions.title.prepare": async ({ params, respond, context, client, signal }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsTitlePrepareParams,
        "sessions.title.prepare",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agent = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg,
      normalize: normalizeOptionalString,
    });
    if (!agent) {
      return;
    }
    const creationError = authorizeGatewaySessionCreation({ cfg, client, agentId: agent.agentId });
    if (creationError) {
      respond(false, undefined, creationError);
      return;
    }
    if (params.model && params.catalogId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.title.prepare catalogId cannot include model",
        ),
      );
      return;
    }
    if (params.incognito || !params.message.trim() || params.message.trim().startsWith("/")) {
      respond(true, { title: null });
      return;
    }
    const catalog = params.catalogId
      ? resolveRegisteredCatalogCreateTarget(params.catalogId, agent.agentId, cfg)
      : undefined;
    if (catalog && !catalog.ok) {
      respond(true, { title: null });
      return;
    }
    try {
      const personalSelection = preparePersonalModelSelection(
        { client, context, signal },
        params.model,
      );
      const assertCurrent = () => {
        personalSelection?.assertCurrent();
        const currentCreationError = authorizeGatewaySessionCreation({
          cfg: context.getRuntimeConfig(),
          client,
          agentId: agent.agentId,
        });
        if (currentCreationError) {
          throw new SessionMutationAuthorizationChangedError(currentCreationError);
        }
      };
      const entry = resolveSessionCreateModelSelection(
        cfg,
        agent.agentId,
        catalog?.target ?? params.model,
      );
      if (!entry) {
        respond(true, { title: null });
        return;
      }
      const title = await prepareDashboardSessionTitle({
        cfg,
        agentId: agent.agentId,
        entry,
        userMessage: params.message,
        abortSignal: signal,
        assertCurrent,
      });
      assertCurrent();
      respond(true, { title });
    } catch (error) {
      const failure =
        error instanceof ModelAccountConnectAuthorityError
          ? errorShape(ErrorCodes.FORBIDDEN, error.message)
          : error instanceof SessionMutationAuthorizationChangedError
            ? error.error
            : undefined;
      if (!failure) {
        throw error;
      }
      respond(false, undefined, failure);
    }
  },
};
