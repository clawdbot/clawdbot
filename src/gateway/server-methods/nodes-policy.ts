import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMANDS } from "../../infra/node-commands.js";
import { ADMIN_SCOPE, PAIRING_SCOPE } from "../operator-scopes.js";
import type { GatewayClient, RespondFn } from "./shared-types.js";

export const nodeInvokePolicy = {
  wakeThrottleMs: 15_000,
  wakeNudgeThrottleMs: 10 * 60_000,
  pendingActionTtlMs: 10 * 60_000,
  pendingActionMaxPerNode: 64,
  canReadPendingNodePairing(client: GatewayClient | null): boolean {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    return scopes.includes(ADMIN_SCOPE) || scopes.includes(PAIRING_SCOPE);
  },
  clientHasOperatorAdminScope(client: GatewayClient | null): boolean {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    return scopes.includes(ADMIN_SCOPE);
  },
  rejectClaudeAgentRun(command: string, respond: RespondFn): boolean {
    if (!(NODE_AGENT_CLI_CLAUDE_RUN_COMMANDS as readonly string[]).includes(command)) {
      return false;
    }
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "node.invoke does not allow Claude agent runs; use sessions.catalog.continue",
        { details: { command } },
      ),
    );
    return true;
  },
};
