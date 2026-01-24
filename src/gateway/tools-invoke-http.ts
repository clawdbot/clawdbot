import type { IncomingMessage, ServerResponse } from "node:http";

import { loadConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey } from "../agents/agent-scope.js";
import { createClawdbotTools } from "../agents/clawdbot-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  isToolAllowedByPolicies,
} from "../agents/pi-tools.policy.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
} from "./http-common.js";

const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;

type ToolsInvokeBody = {
  tool?: unknown;
  action?: unknown;
  args?: unknown;
  sessionKey?: unknown;
  dryRun?: unknown;
};

function resolveSessionKeyFromBody(body: ToolsInvokeBody): string | undefined {
  if (typeof body.sessionKey === "string" && body.sessionKey.trim()) return body.sessionKey.trim();
  return undefined;
}

function mergeActionIntoArgsIfSupported(params: {
  toolSchema: unknown;
  action: string | undefined;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const { toolSchema, action, args } = params;
  if (!action) return args;
  if (args.action !== undefined) return args;
  // TypeBox schemas are plain objects; many tools define an `action` property.
  const schemaObj = toolSchema as { properties?: Record<string, unknown> } | null;
  const hasAction = Boolean(
    schemaObj &&
    typeof schemaObj === "object" &&
    schemaObj.properties &&
    "action" in schemaObj.properties,
  );
  if (!hasAction) return args;
  return { ...args, action };
}

export async function handleToolsInvokeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; maxBodyBytes?: number },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/tools/invoke") return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token } : null,
    req,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) return true;
  const body = (bodyUnknown ?? {}) as ToolsInvokeBody;

  const toolName = typeof body.tool === "string" ? body.tool.trim() : "";
  if (!toolName) {
    sendInvalidRequest(res, "tools.invoke requires body.tool");
    return true;
  }

  const action = typeof body.action === "string" ? body.action.trim() : undefined;

  const argsRaw = body.args;
  const args = (
    argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;

  const sessionKey = resolveSessionKeyFromBody(body) ?? "main";
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);

  // Resolve message channel/account hints (optional headers) for policy inheritance.
  const messageChannel = normalizeMessageChannel(
    getHeader(req, "x-clawdbot-message-channel") ?? "",
  );
  const accountId = getHeader(req, "x-clawdbot-account-id")?.trim() || undefined;

  // Build tool list (core + plugin tools).
  const allTools = createClawdbotTools({
    agentSessionKey: sessionKey,
    agentChannel: messageChannel ?? undefined,
    agentAccountId: accountId,
    config: cfg,
  });

  const policy = resolveEffectiveToolPolicy({ config: cfg, sessionKey });
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey,
    messageProvider: messageChannel ?? undefined,
    accountId: accountId ?? null,
  });

  const allowed = (name: string) =>
    isToolAllowedByPolicies(name, [
      policy.globalPolicy,
      policy.agentPolicy,
      policy.globalProviderPolicy,
      policy.agentProviderPolicy,
      groupPolicy,
    ]);

  const tools = (allTools as any[]).filter((t) => allowed(t.name));

  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    sendJson(res, 404, {
      ok: false,
      error: { type: "not_found", message: `Tool not available: ${toolName}` },
    });
    return true;
  }

  try {
    const toolArgs = mergeActionIntoArgsIfSupported({
      toolSchema: (tool as any).parameters,
      action,
      args,
    });
    const result = await (tool as any).execute?.(`http-${Date.now()}`, toolArgs);
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    sendJson(res, 400, {
      ok: false,
      error: { type: "tool_error", message: err instanceof Error ? err.message : String(err) },
    });
  }

  return true;
}
