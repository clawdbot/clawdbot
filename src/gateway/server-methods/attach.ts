import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionStoreEntryProtected,
} from "../../sessions/agent-harness-session-key.js";
import { mintAttachGrant, revokeAttachGrant } from "../mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "../mcp-http.js";
import {
  createMcpAttachGrantServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../mcp-http.loopback-runtime.js";
import type { GatewayRequestHandlers } from "./types.js";

function paramRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export const attachHandlers: GatewayRequestHandlers = {
  "attach.grant": async ({ params, respond, context }) => {
    const grantParams = paramRecord(params);
    const cfg = context.getRuntimeConfig();
    const sessionKey = readString(grantParams, "sessionKey") ?? resolveMainSessionKey(cfg);
    const harnessEntry = isAgentHarnessSessionKey(sessionKey)
      ? resolveSessionEntryAccessTarget({ cfg, sessionKey }).entry
      : undefined;
    if (
      isAgentHarnessSessionKey(sessionKey) &&
      (!harnessEntry || isAgentHarnessSessionStoreEntryProtected(sessionKey, harnessEntry))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE),
      );
      return;
    }
    await ensureMcpLoopbackServer();
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "mcp loopback server unavailable"),
      );
      return;
    }
    const grant = mintAttachGrant({ sessionKey, ttlMs: readPositiveNumber(grantParams, "ttlMs") });
    respond(true, {
      sessionKey: grant.sessionKey,
      token: grant.token,
      expiresAtMs: grant.expiresAtMs,
      mcpConfig: createMcpAttachGrantServerConfig(runtime.port),
      env: {
        OPENCLAW_MCP_TOKEN: grant.token,
      },
    });
  },
  "attach.revoke": async ({ params, respond }) => {
    const token = readString(paramRecord(params), "token");
    if (!token) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "token is required"));
      return;
    }
    respond(true, { revoked: revokeAttachGrant(token) });
  },
};
