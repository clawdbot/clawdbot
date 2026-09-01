import { isIncognitoSessionKey } from "../routing/session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";

const INCOGNITO_SYSTEM_PROMPT =
  "This chat is incognito; do not store its conversation content in memory files or long-term notes.";

export function appendIncognitoSystemPrompt(params: {
  agentId: string;
  extraSystemPrompt?: string;
  sessionKey?: string;
  storePath?: string;
}): string | undefined {
  const incognito =
    isIncognitoSessionKey(params.sessionKey) ||
    (params.storePath &&
      isIncognitoOpenClawAgentSqlitePath(params.storePath, { agentId: params.agentId }));
  if (!incognito) {
    return params.extraSystemPrompt;
  }
  const existing = params.extraSystemPrompt?.trim();
  return existing ? `${existing}\n\n${INCOGNITO_SYSTEM_PROMPT}` : INCOGNITO_SYSTEM_PROMPT;
}
