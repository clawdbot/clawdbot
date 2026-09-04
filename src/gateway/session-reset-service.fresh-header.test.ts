import { afterEach, expect, test } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../agents/sessions/session-manager.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { appendTranscriptMessageSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

test("fresh /new reset persists a canonical session header before the reset event", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:telegram:direct:fresh-new";
  const sessionId = "fresh-new-session";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });

  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  const reset = await performGatewaySessionReset({
    key: sessionKey,
    reason: "new",
    commandSource: "telegram:text",
    workerPlacementContext: {},
  });

  expect(reset).toMatchObject({ ok: true, entry: { sessionId } });
  const entry = loadSessionEntry({ sessionKey, storePath });
  expect(entry?.sessionId).toBe(sessionId);

  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  const events = await loadTranscriptEvents(scope);
  expect(events[0]).toMatchObject({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
  });
  expect(events).toContainEqual(expect.objectContaining({ type: "reset", reason: "new" }));

  expect(() => SessionManager.openModelContext(scope)).not.toThrow();
  expect(() => SessionManager.open(scope)).not.toThrow();

  appendTranscriptMessageSync(scope, {
    eventId: "post-reset-ping",
    message: { role: "user", content: "ping" },
    parentId: (
      events.find((event) => (event as { type?: unknown }).type === "reset") as { id: string }
    ).id,
  });
  expect(() => SessionManager.openModelContext(scope)).not.toThrow();
  expect(SessionManager.openModelContext(scope).buildSessionContext().messages).toEqual([
    expect.objectContaining({ role: "user", content: "ping" }),
  ]);
});
