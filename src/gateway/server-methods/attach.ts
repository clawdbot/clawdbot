import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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

function readPositiveNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export const attachHandlers: GatewayRequestHandlers = {
  "attach.grant": async ({ params, respond, context }) => {
    const grantParams = asRecord(params);
    const cfg = context.getRuntimeConfig();
    const sessionKey =
      normalizeOptionalString(grantParams.sessionKey) ?? resolveMainSessionKey(cfg);
    const agentId =
      sessionKey === "global" ? normalizeOptionalString(grantParams.agentId) : undefined;
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
    const grant = mintAttachGrant({
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ttlMs: readPositiveNumber(grantParams, "ttlMs"),
    });
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
    const token = normalizeOptionalString(asRecord(params).token);
    if (!token) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "token is required"));
      return;
    }
    respond(true, { revoked: revokeAttachGrant(token) });
  },
};
