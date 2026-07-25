import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentIdentityParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolvePublicAgentAvatarSource } from "../../agents/identity-avatar.js";
import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import { resolveGatewayAssistantAvatar } from "../assistant-avatar.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import type { GatewayRequestHandlers } from "./types.js";

export const agentIdentityGetHandler: GatewayRequestHandlers["agent.identity.get"] = ({
  params,
  respond,
  context,
}) => {
  if (!validateAgentIdentityParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid agent.identity.get params: ${formatValidationErrors(
          validateAgentIdentityParams.errors,
        )}`,
      ),
    );
    return;
  }
  const agentIdRaw = normalizeOptionalString(params.agentId) ?? "";
  const sessionKeyRaw = normalizeOptionalString(params.sessionKey) ?? "";
  let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (sessionKeyRaw) {
    if (classifySessionKeyShape(sessionKeyRaw) === "malformed_agent") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.identity.get params: malformed session key "${sessionKeyRaw}"`,
        ),
      );
      return;
    }
    const resolved = resolveAgentIdFromSessionKey(sessionKeyRaw);
    if (agentId && resolved !== agentId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.identity.get params: agent "${agentIdRaw}" does not match session key agent "${resolved}"`,
        ),
      );
      return;
    }
    agentId = resolved;
  }
  const cfg = context.getRuntimeConfig();
  const identity = resolveAssistantIdentity({ cfg, agentId });
  const avatarProjection = resolveGatewayAssistantAvatar({ cfg, identity });
  const avatarResolution = avatarProjection.resolution;
  respond(
    true,
    {
      ...identity,
      avatar: avatarProjection.avatar,
      avatarSource: avatarResolution ? resolvePublicAgentAvatarSource(avatarResolution) : undefined,
      avatarStatus: avatarResolution?.kind,
      avatarReason: avatarResolution?.kind === "none" ? avatarResolution.reason : undefined,
    },
    undefined,
  );
};
