import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  buildAllowedModelSet,
  modelKey,
  parseModelRef,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { getRuntimeConfig } from "../config/io.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getHeader } from "./http-auth-utils.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";

export {
  authorizeGatewayHttpRequestOrReply,
  authorizeScopedGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  getBearerToken,
  getHeader,
  isGatewayBearerHttpRequest,
  resolveHttpBrowserOriginPolicy,
  resolveHttpSenderIsOwner,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
  resolveTrustedHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
  type GatewayHttpRequestAuthCheckResult,
} from "./http-auth-utils.js";

export const OPENCLAW_MODEL_ID = "openclaw";
export const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";

function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    normalizeOptionalString(getHeader(req, "x-openclaw-agent-id")) ||
    normalizeOptionalString(getHeader(req, "x-openclaw-agent")) ||
    "";
  if (!raw) {
    return undefined;
  }
  return normalizeAgentId(raw);
}

export function resolveAgentIdFromModel(
  model: string | undefined,
  cfg = getRuntimeConfig(),
): string | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === OPENCLAW_MODEL_ID || lowered === OPENCLAW_DEFAULT_MODEL_ID) {
    return resolveDefaultAgentId(cfg);
  }

  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  const agentId = m?.groups?.agentId;
  if (!agentId) {
    return undefined;
  }
  return normalizeAgentId(agentId);
}

export async function resolveOpenAiCompatModelOverride(params: {
  req: IncomingMessage;
  agentId: string;
  model: string | undefined;
}): Promise<{ modelOverride?: string; errorMessage?: string }> {
  const requestModel = params.model?.trim();
  if (requestModel && !resolveAgentIdFromModel(requestModel)) {
    return {
      errorMessage: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
    };
  }

  const raw = getHeader(params.req, "x-openclaw-model")?.trim();
  if (!raw) {
    return {};
  }

  const cfg = getRuntimeConfig();
  const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
  const defaultProvider = defaultModelRef.provider;
  const parsed = parseModelRef(raw, defaultProvider);
  if (!parsed) {
    return { errorMessage: "Invalid `x-openclaw-model`." };
  }

  const catalog = await loadGatewayModelCatalog();
  const allowed = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider,
    agentId: params.agentId,
  });
  const normalized = modelKey(parsed.provider, parsed.model);
  if (!allowed.allowAny && !allowed.allowedKeys.has(normalized)) {
    return {
      errorMessage: `Model '${normalized}' is not allowed for agent '${params.agentId}'.`,
    };
  }

  return { modelOverride: raw };
}

export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const cfg = getRuntimeConfig();
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) {
    return fromHeader;
  }

  const fromModel = resolveAgentIdFromModel(params.model, cfg);
  return fromModel ?? resolveDefaultAgentId(cfg);
}

function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  prefix: string;
}): string {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  if (explicit) {
    return explicit;
  }

  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

export function resolveGatewayRequestContext(params: {
  req: IncomingMessage;
  model: string | undefined;
  user?: string | undefined;
  sessionPrefix: string;
  defaultMessageChannel: string;
  useMessageChannelHeader?: boolean;
}): { agentId: string; sessionKey: string; messageChannel: string } {
  const agentId = resolveAgentIdForRequest({ req: params.req, model: params.model });
  const sessionKey = resolveSessionKey({
    req: params.req,
    agentId,
    user: params.user,
    prefix: params.sessionPrefix,
  });

  const messageChannel = params.useMessageChannelHeader
    ? (normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ??
      params.defaultMessageChannel)
    : params.defaultMessageChannel;

  return { agentId, sessionKey, messageChannel };
}
