import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateAgentIdentityParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolvePublicAgentAvatarSource } from "../../agents/identity-avatar.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import { resolveGatewayAssistantAvatar } from "../assistant-avatar.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentIdentityGetHandler: GatewayRequestHandlers["agent.identity.get"] = ({
  params,
  respond,
  context,
}) => {
  if (!assertValidParams(params, validateAgentIdentityParams, "agent.identity.get", respond)) {
    return;
  }
  const agentIdRaw = normalizeOptionalString(params.agentId) ?? "";
  const sessionKeyRaw = normalizeOptionalString(params.sessionKey) ?? "";
  const cfg = context.getRuntimeConfig();
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
    const resolved = resolveRequestedSessionAgentId(cfg, sessionKeyRaw, agentId);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    agentId = resolved.agentId;
  } else if (!agentId) {
    const resolved = resolveRequestedSessionAgentId(cfg, "main");
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    agentId = resolved.agentId;
  }
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

export const agentIdentityHandlers: GatewayRequestHandlers = {
  "agent.identity.get": agentIdentityGetHandler,
};
