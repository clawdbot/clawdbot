import { encodeResumeHandoff } from "../../../../src/shared/resume-handoff.js";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

type ContinueInTerminalCommandResult =
  | { ok: true; command: string; qualifiedSessionKey: string }
  | { ok: false; reason: "query-routed" | "unavailable" };

export function buildContinueInTerminalCommand(params: {
  gatewayUrl: string;
  sessionKey: string;
  rowAgentId?: string;
  selectedAgentId?: string;
}): ContinueInTerminalCommandResult {
  const { gatewayUrl, sessionKey } = params;
  let parsedGatewayUrl: URL;
  try {
    parsedGatewayUrl = new URL(gatewayUrl);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (parsedGatewayUrl.hash) {
    return { ok: false, reason: "unavailable" };
  }
  if (
    (parsedGatewayUrl.protocol === "ws:" || parsedGatewayUrl.protocol === "wss:") &&
    parsedGatewayUrl.search
  ) {
    return { ok: false, reason: "query-routed" };
  }
  let qualifiedKey = sessionKey;
  if (!parseAgentSessionKey(sessionKey)) {
    const agentId = params.rowAgentId || params.selectedAgentId;
    if (!agentId) {
      return { ok: false, reason: "unavailable" };
    }
    qualifiedKey = `agent:${agentId}:${sessionKey}`;
  }
  try {
    return {
      ok: true,
      command: `openclaw resume --handoff ${encodeResumeHandoff({ sessionKey: qualifiedKey, gatewayUrl })}`,
      qualifiedSessionKey: qualifiedKey,
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
