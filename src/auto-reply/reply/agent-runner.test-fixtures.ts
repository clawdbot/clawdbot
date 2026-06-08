// Shared fixtures for agent runner tests and temporary session files.
import type { SessionEntry } from "../../config/sessions.js";
import { writeSessionStoreForTestAsync } from "../../config/sessions/test-helpers.js";
import type { FollowupRun } from "./queue.js";

export function createTestFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: true,
      ...overrides,
    },
  } as unknown as FollowupRun;
}

export async function writeTestSessionStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  await writeSessionStoreForTestAsync(storePath, { [sessionKey]: entry });
}
