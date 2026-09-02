import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsTitlePrepareParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { prepareDashboardSessionTitle } from "../dashboard-session-title.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolveSessionCreateModelSelection } from "../session-create-model-selection.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { resolveRegisteredCatalogCreateTarget } from "./session-catalog.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionTitleHandlers: GatewayRequestHandlers = {
  "sessions.title.prepare": async ({ params, respond, context, client }) => {
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
    });
    respond(true, { title });
  },
};
