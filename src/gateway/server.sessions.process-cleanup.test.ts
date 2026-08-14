/**
 * Gateway lifecycle proof for session-scoped completed process cleanup.
 */
import { afterEach, expect, test } from "vitest";
import {
  addSession,
  getFinishedSession,
  getSession,
  markExited,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  resetProcessRegistryForTests();
  closeOpenClawStateDatabaseForTest();
});

function seedFinishedProcess(id: string, scopeKey: string) {
  const session = createProcessSessionFixture({ id, backgrounded: true });
  session.scopeKey = scopeKey;
  addSession(session);
  markExited(session, 0, null, "completed");
}

test("sessions.reset purges finished processes for every retired session identity", async () => {
  await seedActiveMainSession();
  seedFinishedProcess("finished-main-alias", "main");
  seedFinishedProcess("finished-main-canonical", "agent:main:main");
  seedFinishedProcess("finished-main-id", "sess-main");
  seedFinishedProcess("finished-other-session", "agent:main:other");
  seedFinishedProcess("finished-shared-scope", "explicit:shared");

  const running = createProcessSessionFixture({
    id: "running-main-process",
    backgrounded: true,
  });
  running.scopeKey = "agent:main:main";
  addSession(running);

  const reset = await directSessionReq("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(getFinishedSession("finished-main-alias")).toBeUndefined();
  expect(getFinishedSession("finished-main-canonical")).toBeUndefined();
  expect(getFinishedSession("finished-main-id")).toBeUndefined();
  expect(getFinishedSession("finished-other-session")).toBeDefined();
  expect(getFinishedSession("finished-shared-scope")).toBeDefined();
  expect(getSession("running-main-process")).toBe(running);
});

test("sessions.delete purges only completed processes owned by the deleted session", async () => {
  await createSessionStoreDir();
  const requestedKey = "discord:group:retention-proof";
  const canonicalKey = "agent:main:discord:group:retention-proof";
  const sessionId = "sess-retention-delete";
  await writeSessionStore({
    entries: { [requestedKey]: sessionStoreEntry(sessionId) },
  });
  seedFinishedProcess("finished-delete-alias", requestedKey);
  seedFinishedProcess("finished-delete-canonical", canonicalKey);
  seedFinishedProcess("finished-delete-id", sessionId);
  seedFinishedProcess("finished-delete-other", "agent:main:other");

  const deleted = await directSessionReq("sessions.delete", { key: requestedKey });

  expect(deleted.ok).toBe(true);
  expect(getFinishedSession("finished-delete-alias")).toBeUndefined();
  expect(getFinishedSession("finished-delete-canonical")).toBeUndefined();
  expect(getFinishedSession("finished-delete-id")).toBeUndefined();
  expect(getFinishedSession("finished-delete-other")).toBeDefined();
});
