import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionEntry } from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
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
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: params.target.agentId,
    sessionId: params.target.entry.sessionId,
    storePath: params.target.storePath,
  });
  SessionManager.open(sessionFile).appendMessage(
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
