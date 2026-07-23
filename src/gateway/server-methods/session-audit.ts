import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveTranscriptSessionKeyBySessionId } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export async function appendSessionAudit(params: {
  cfg: OpenClawConfig;
  target: {
    agentId: string;
    entry: Pick<SessionEntry, "sessionId">;
    storePath: string;
  };
  text: string;
  now: number;
}): Promise<void> {
  const identity = {
    agentId: params.target.agentId,
    sessionId: params.target.entry.sessionId,
    storePath: params.target.storePath,
  };
  const sessionKey = resolveTranscriptSessionKeyBySessionId(identity);
  if (!sessionKey) {
    return;
  }
  SessionManager.open({ ...identity, sessionKey }).appendMessage(
    {
      role: "custom",
      customType: "openclaw.system-note",
      content: `System note: ${params.text}`,
      display: true,
      timestamp: params.now,
    },
    { config: params.cfg },
  );
}
