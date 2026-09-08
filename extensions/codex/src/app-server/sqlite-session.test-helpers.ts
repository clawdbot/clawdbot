import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

export async function attachSqliteSessionTarget(
  params: EmbeddedRunAttemptParams,
  storePath: string,
  sessionId: string,
): Promise<void> {
  params.sessionId = sessionId;
  params.sessionKey = `agent:main:${sessionId}`;
  params.sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey: params.sessionKey,
    storePath,
  };
  await upsertSessionEntry({
    agentId: "main",
    sessionKey: params.sessionKey,
    storePath,
    entry: { sessionFile: params.sessionFile, sessionId, updatedAt: Date.now() },
  });
}
