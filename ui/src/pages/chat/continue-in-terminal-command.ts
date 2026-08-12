import { quoteCliArg } from "../../../../src/cli/quote-cli-arg.js";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { hasTerminalControl } from "../../lib/terminal-command.ts";

export function buildContinueInTerminalCommand(params: {
  gatewayUrl: string;
  sessionKey: string;
  rowAgentId?: string;
  selectedAgentId?: string;
}): string | null {
  const { gatewayUrl, sessionKey } = params;
  if (!sessionKey || hasTerminalControl(sessionKey)) {
    return null;
  }
  if (!gatewayUrl || hasTerminalControl(gatewayUrl) || gatewayUrl.includes("?")) {
    return null;
  }
  if (gatewayUrl.includes("#") || !/^wss?:\/\//u.test(gatewayUrl)) {
    return null;
  }
  const authority = gatewayUrl.slice(gatewayUrl.indexOf("://") + 3).split("/", 1)[0] ?? "";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(gatewayUrl);
  } catch {
    return null;
  }
  if (
    (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") ||
    authority.includes("@") ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    return null;
  }

  let qualifiedKey = sessionKey;
  if (!parseAgentSessionKey(sessionKey)) {
    const agentId = params.rowAgentId || params.selectedAgentId;
    if (!agentId || hasTerminalControl(agentId)) {
      return null;
    }
    qualifiedKey = `agent:${agentId}:${sessionKey}`;
  }
  return `openclaw resume ${quoteCliArg(qualifiedKey)} --url ${quoteCliArg(gatewayUrl)}`;
}
