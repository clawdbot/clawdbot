import fs from "node:fs";
import path from "node:path";
import { loadFollowupQueueEntries } from "../../../infra/followup-queue-sqlite.js";
import type { FollowupRun, QueueSettings } from "./types.js";

export const FOLLOWUP_PERSIST_TEST_KEY = "agent:main:dm:persist-test";

export const FOLLOWUP_PERSIST_TEST_SETTINGS: QueueSettings = {
  mode: "steer",
  debounceMs: 500,
  cap: 20,
  dropPolicy: "summarize",
};

export function createFollowupPersistTestRun(): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "sess-persist",
    sessionKey: FOLLOWUP_PERSIST_TEST_KEY,
    sessionFile: "/tmp/sess.jsonl",
    workspaceDir: "/tmp/ws",
    config: {} as FollowupRun["run"]["config"],
    provider: "anthropic",
    model: "claude",
    timeoutMs: 30000,
    blockReplyBreak: "message_end",
  };
}

export function createFollowupPersistTestItem(prompt: string): FollowupRun {
  return {
    prompt,
    enqueuedAt: Date.now(),
    run: createFollowupPersistTestRun(),
    originatingChannel: "telegram",
    originatingTo: "12345",
  };
}

export function writeFollowupPersistWorkspaceSkill(workspaceDir: string, name: string): string {
  const skillFile = path.join(workspaceDir, "skills", name, "SKILL.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(
    skillFile,
    `---\nname: ${name}\ndescription: ${name} skill for follow-up restore\n---\n`,
  );
  return path.resolve(skillFile);
}

export function readFollowupPersistQueueEntry(key: string): unknown {
  return loadFollowupQueueEntries().find(([entryKey]) => entryKey === key)?.[1];
}
