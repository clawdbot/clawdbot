/**
 * First user turn for a native `sessions_spawn` / subagent run.
 *
 * Keep the delegated task transcript-visible and single-sourced here. The
 * system prompt owns runtime/subagent rules; this user turn owns the actual
 * task envelope so delivery is easy to audit without duplicating tokens.
 */
export function buildSubagentInitialUserMessage(params: {
  childDepth: number;
  maxSpawnDepth: number;
  /** When true, this subagent uses a persistent session for follow-up messages. */
  persistentSession: boolean;
  task?: string;
}): string {
  const lines = [
    `[Subagent Context] You are running as a subagent (depth ${params.childDepth}/${params.maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
  ];
  if (params.persistentSession) {
    lines.push(
      "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages.",
    );
  }
  const taskBody = params.task?.trim();
  if (taskBody) {
    lines.push("[Subagent Task]", taskBody, "Begin. Execute the assigned task to completion.");
  } else {
    lines.push("Begin. Execute the assigned task to completion.");
  }
  return lines.join("\n\n");
}
