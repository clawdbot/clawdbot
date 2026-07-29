// Gateway HTTP request helpers.
// Resolves OpenAI-compatible agent/model/session headers and re-exports auth helpers.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { modelKey, parseModelRef, resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionEntryAccessTarget } from "../config/sessions/session-accessor.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import {
  buildAgentMainSessionKey,
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  isValidAgentId,
  normalizeAgentId,
} from "../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionStoreEntryProtected,
} from "../sessions/agent-harness-session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getHeader } from "./http-auth-utils.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { canonicalizeSessionKeyForAgent } from "./session-store-key.js";

export {
  authorizeOpenAiCompatibleHttpModelOverride,
  authorizeGatewayHttpRequestOrReply,
  authorizeScopedGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  getBearerToken,
  getHeader,
  resolveHttpBrowserOriginPolicy,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
  resolveSharedSecretHttpOperatorScopes,
  resolveTrustedHttpOperatorScopes,
  setControlUiPluginAuthCookieForRequest,
  type AuthorizedGatewayHttpRequest,
} from "./http-auth-utils.js";

export const OPENCLAW_MODEL_ID = "openclaw";
/** Default OpenAI-compatible model alias that targets the default OpenClaw agent. */
export const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";

class UnknownGatewayAgentError extends Error {
  constructor(readonly agentId: string) {
    super(`Unknown agent '${agentId}'.`);
    this.name = "UnknownGatewayAgentError";
  }
}

class GatewaySessionKeyOverrideError extends Error {
  constructor() {
    super("`x-openclaw-session-key` cannot use reserved internal session namespaces.");
    this.name = "GatewaySessionKeyOverrideError";
  }
}

export function isUnknownGatewayAgentError(err: unknown): err is UnknownGatewayAgentError {
  return err instanceof UnknownGatewayAgentError;
}

export function isGatewaySessionKeyOverrideError(
  err: unknown,
): err is GatewaySessionKeyOverrideError {
  return err instanceof GatewaySessionKeyOverrideError;
}

function assertKnownAgentId(agentId: string, cfg = getRuntimeConfig()): void {
  if (!listAgentIds(cfg).includes(agentId)) {
    throw new UnknownGatewayAgentError(agentId);
  }
}

function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    normalizeOptionalString(getHeader(req, "x-openclaw-agent-id")) ||
    normalizeOptionalString(getHeader(req, "x-openclaw-agent")) ||
    "";
  if (!raw) {
    return undefined;
  }
  if (!isValidAgentId(raw)) {
    throw new UnknownGatewayAgentError(raw);
  }
  return normalizeAgentId(raw);
}

/** Resolves the target agent encoded by an OpenAI-compatible model id. */
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

/** Validates and resolves the `x-openclaw-model` override for OpenAI-compatible requests. */
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
  const workspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  const manifestMetadataSnapshot = getCurrentPluginMetadataSnapshot({
    config: cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot?.plugins,
  };
  const parsed = parseModelRef(raw, defaultProvider, {
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  if (!parsed) {
    return { errorMessage: "Invalid `x-openclaw-model`." };
  }

  // Overrides must pass the same visibility policy as model picker surfaces;
  // otherwise API clients could target hidden plugin/provider models by header.
  const catalog = await loadGatewayModelCatalog();
  const policy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider,
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  const normalized = modelKey(parsed.provider, parsed.model);
  if (!policy.allowsKey(normalized)) {
    return {
      errorMessage: `Model '${normalized}' is not allowed for agent '${params.agentId}'.`,
    };
  }

  return { modelOverride: raw };
}

/** Resolves the request agent from headers, model alias, or the configured default. */
export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const cfg = getRuntimeConfig();
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) {
    assertKnownAgentId(fromHeader, cfg);
    return fromHeader;
  }

  const fromModel = resolveAgentIdFromModel(params.model, cfg);
  if (fromModel) {
    assertKnownAgentId(fromModel, cfg);
    return fromModel;
  }

  return resolveDefaultAgentId(cfg);
}

function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  prefix: string;
}): string {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  if (explicit) {
    if (isReservedSessionKeyOverride(explicit, params.agentId)) {
      throw new GatewaySessionKeyOverrideError();
    }
    return explicit;
  }

  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

function isReservedSessionKeyOverride(sessionKey: string, agentId: string): boolean {
  const lowered = normalizeLowercaseStringOrEmpty(sessionKey);
  const harnessLookupKey = sessionKey.startsWith("agent:")
    ? sessionKey
    : canonicalizeSessionKeyForAgent(agentId, sessionKey);
  const harnessEntry = isAgentHarnessSessionKey(sessionKey)
    ? resolveSessionEntryAccessTarget({
        cfg: getRuntimeConfig(),
        sessionKey: harnessLookupKey,
      }).entry
    : undefined;
  const harnessKeyReserved =
    isAgentHarnessSessionKey(sessionKey) &&
    (!harnessEntry || isAgentHarnessSessionStoreEntryProtected(sessionKey, harnessEntry));
  return (
    lowered.startsWith("subagent:") ||
    lowered.startsWith("cron:") ||
    lowered.startsWith("acp:") ||
    harnessKeyReserved ||
    isSubagentSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey)
  );
}

/** Resolves gateway agent/session/channel context for OpenAI-compatible handlers. */
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
