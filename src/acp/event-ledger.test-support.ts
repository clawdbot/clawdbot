import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";

/** Independent stored-content ground truth, including NUL and replacement characters. */
export function expectAcpReplayUtf8Accounting(db: DatabaseSync): number {
  const encoder = new TextEncoder();
  const bytes = (value: unknown) => (typeof value === "string" ? encoder.encode(value).length : 0);
  const sessions = db.prepare("SELECT * FROM acp_replay_sessions ORDER BY session_id").all();
  const events = db.prepare("SELECT * FROM acp_replay_events ORDER BY session_id, seq").all();
  let total = 0;
  for (const session of sessions) {
    let expected = bytes(session.session_id) + bytes(session.session_key) + bytes(session.cwd) + 32;
    for (const event of events.filter((row) => row.session_id === session.session_id)) {
      const eventBytes =
        bytes(event.session_id) +
        bytes(event.session_key) +
        bytes(event.run_id) +
        bytes(event.update_json) +
        32;
      expect(Number(event.estimated_bytes)).toBe(eventBytes);
      expected += eventBytes;
    }
    expect(Number(session.estimated_bytes)).toBe(expected);
    total += expected;
  }
  return total;
}
