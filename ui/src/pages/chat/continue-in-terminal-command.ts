import { encodeResumeHandoff } from "../../../../src/shared/resume-handoff.js";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

export function buildContinueInTerminalCommand(params: {
  gatewayUrl: string;
  sessionKey: string;
  rowAgentId?: string;
  selectedAgentId?: string;
}): string | null {
  const { gatewayUrl, sessionKey } = params;
  let qualifiedKey = sessionKey;
  if (!parseAgentSessionKey(sessionKey)) {
    const agentId = params.rowAgentId || params.selectedAgentId;
    if (!agentId) {
      return null;
    }
    qualifiedKey = `agent:${agentId}:${sessionKey}`;
  }
  try {
    return `openclaw resume --handoff ${encodeResumeHandoff({ sessionKey: qualifiedKey, gatewayUrl })}`;
  } catch {
    return null;
  }
}
