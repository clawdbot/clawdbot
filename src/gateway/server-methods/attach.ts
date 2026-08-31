import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
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
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

export const attachHandlers: GatewayRequestHandlers = {
  "attach.grant": async ({ params, respond, context }) => {
    const grantParams = asRecord(params);
    const cfg = context.getRuntimeConfig();
    const requestedSessionKey = normalizeOptionalString(grantParams.sessionKey) ?? "main";
    const requestedAgent = resolveRequestedSessionAgentId(
      cfg,
      requestedSessionKey,
      normalizeOptionalString(grantParams.agentId),
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const storageSessionKey = resolveSessionStoreKey({
      cfg,
      sessionKey: requestedSessionKey,
      storeAgentId: requestedAgent.agentId,
    });
    const sessionKey = parseAgentSessionKey(storageSessionKey)
      ? storageSessionKey
      : `agent:${requestedAgent.agentId}:${storageSessionKey}`;
    const harnessEntry = isAgentHarnessSessionKey(storageSessionKey)
      ? resolveSessionEntryAccessTarget({ cfg, sessionKey: storageSessionKey }).entry
      : undefined;
    if (
      isAgentHarnessSessionKey(storageSessionKey) &&
      (!harnessEntry || isAgentHarnessSessionStoreEntryProtected(storageSessionKey, harnessEntry))
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
      ttlMs: asPositiveFiniteNumber(grantParams.ttlMs),
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
