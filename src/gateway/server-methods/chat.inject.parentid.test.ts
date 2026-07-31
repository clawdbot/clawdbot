// Chat transcript parent-id tests protect gateway-injected assistant appends so
// compaction history remains connected and transcript listeners receive updates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";

type SqliteTranscriptFixture = {
  agentId: string;
  dir: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
};

async function createSqliteTranscriptFixture(params: {
  prefix: string;
  sessionId: string;
}): Promise<SqliteTranscriptFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const sessionKey = "main";
  const agentId = "main";
  const storePath = path.join(dir, "sessions.json");
  await replaceSessionEntry(
    { agentId, sessionKey, storePath },
    { sessionId: params.sessionId, updatedAt: Date.now() },
  );
  return { agentId, dir, sessionKey, sessionId: params.sessionId, storePath };
}

async function cleanupFixture(fixture: { dir: string }) {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

async function readTranscriptEvents(
  fixture: SqliteTranscriptFixture,
): Promise<Record<string, unknown>[]> {
  return (await loadTranscriptEvents({
    agentId: fixture.agentId,
    sessionId: fixture.sessionId,
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
  })) as Record<string, unknown>[];
}

async function appendHelloAndRequireId(fixture: SqliteTranscriptFixture): Promise<string> {
  const appended = await appendInjectedAssistantMessageToTranscript({
    agentId: fixture.agentId,
    sessionId: fixture.sessionId,
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
    message: "hello",
  });
  expect(appended.ok).toBe(true);
  expect(appended.messageId).toBeTypeOf("string");
  const messageId = appended.messageId;
  if (!messageId) {
    throw new Error("expected appended message id");
  }
  expect(messageId.length).toBeGreaterThan(0);
  return messageId;
}

async function readLastTranscriptRecord(
  fixture: SqliteTranscriptFixture,
): Promise<Record<string, unknown>> {
  const events = await readTranscriptEvents(fixture);
  expect(events.length).toBeGreaterThanOrEqual(2);
  return events.at(-1) as Record<string, unknown>;
}

// Guardrail: Gateway-injected assistant transcript messages must attach to the
// current leaf with a `parentId` and must not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it("appends a agent session entry that includes parentId", async () => {
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-",
      sessionId: "sess-1",
    });

    try {
      await appendHelloAndRequireId(fixture);
      const last = await readLastTranscriptRecord(fixture);
      expect(last.type).toBe("message");

      // Gateway appends must go through the transcript accessor so parent links
      // stay connected for compaction and chat.history projection.
      expect(Object.hasOwn(last, "parentId")).toBe(true);
      expect(last).toHaveProperty("id");
      expect(last).toHaveProperty("message");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("preserves parent links after an oversized transcript row", async () => {
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-large-",
      sessionId: "sess-1",
    });

    try {
      const existing = appendTranscriptMessageSync(
        {
          agentId: fixture.agentId,
          sessionId: fixture.sessionId,
          sessionKey: fixture.sessionKey,
          storePath: fixture.storePath,
        },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
          },
        },
      );

      const messageId = await appendHelloAndRequireId(fixture);
      const last = await readLastTranscriptRecord(fixture);

      expect(existing).toBeDefined();
      expect(last.type).toBe("message");
      expect(last).toHaveProperty("id", messageId);
      expect(last).toHaveProperty("message");
      expect(last).toHaveProperty("parentId", existing?.messageId);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("emits and returns the redacted injected assistant message", async () => {
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-redact-",
      sessionId: "sess-redact",
    });
    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const updates: Array<{ message?: unknown; sessionKey?: string; agentId?: string }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const appended = await appendInjectedAssistantMessageToTranscript({
        agentId: fixture.agentId,
        sessionId: fixture.sessionId,
        sessionKey: "global",
        storePath: fixture.storePath,
        message: `Here is your key: ${fakeApiKey}`,
        config: {},
      });

      expect(appended.ok).toBe(true);
      expect(JSON.stringify(appended.message)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ sessionKey: "global", agentId: "main" });

      const last = (await readLastTranscriptRecord(fixture)) as { message?: unknown };
      expect(JSON.stringify(last.message)).not.toContain(fakeApiKey);
      expect(updates[0]?.message).toEqual(last.message);
      expect(JSON.stringify(updates[0]?.message)).not.toContain(fakeApiKey);
    } finally {
      unsubscribe();
      await cleanupFixture(fixture);
    }
  });
});
