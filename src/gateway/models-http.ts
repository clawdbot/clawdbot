import type { IncomingMessage, ServerResponse } from "node:http";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendInvalidRequest, sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  OPENCLAW_DEFAULT_MODEL_ID,
  OPENCLAW_MODEL_ID,
  authorizeGatewayHttpRequestOrReply,
  type AuthorizedGatewayHttpRequest,
  resolveAgentIdFromModel,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

type OpenAiModelsHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiModelObject = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  permission: [];
};

function toOpenAiModel(id: string): OpenAiModelObject {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "openclaw",
    permission: [],
  };
}

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<AuthorizedGatewayHttpRequest | null> {
  return await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
}

function loadAgentModelIds(): string[] {
  const cfg = getRuntimeConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const ids = new Set<string>([OPENCLAW_MODEL_ID, OPENCLAW_DEFAULT_MODEL_ID]);
  ids.add(`openclaw/${defaultAgentId}`);
  for (const agentId of listAgentIds(cfg)) {
    ids.add(`openclaw/${agentId}`);
  }
  return Array.from(ids);
}

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).pathname;
}

export async function handleOpenAiModelsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (requestPath !== "/v1/models" && !requestPath.startsWith("/v1/models/")) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const requestAuth = await authorizeRequest(req, res, opts);
  if (!requestAuth) {
    return true;
  }

  const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("models.list", requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: `missing scope: ${scopeAuth.missingScope}`,
      },
    });
    return true;
  }

  const ids = loadAgentModelIds();
  if (requestPath === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: ids.map(toOpenAiModel),
    });
    return true;
  }

  const encodedId = requestPath.slice("/v1/models/".length);
  if (!encodedId) {
    sendInvalidRequest(res, "Missing model id.");
    return true;
  }

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(encodedId);
  } catch {
    sendInvalidRequest(res, "Invalid model id encoding.");
    return true;
  }

  if (decodedId !== OPENCLAW_MODEL_ID && !resolveAgentIdFromModel(decodedId)) {
    sendInvalidRequest(res, "Invalid model id.");
    return true;
  }

  if (!ids.includes(decodedId)) {
    sendJson(res, 404, {
      error: {
        message: `Model '${decodedId}' not found.`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  sendJson(res, 200, toOpenAiModel(decodedId));
  return true;
}
