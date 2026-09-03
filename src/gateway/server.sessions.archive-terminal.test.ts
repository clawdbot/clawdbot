// Archive terminal tests protect exact durable-session ownership at the RPC boundary.
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "./terminal/session-manager.test-helpers.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("sessions.patch closes only the exact terminal session incarnation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-terminal";
  const oldOwner = agentTerminalOwner(sessionKey, "S1");
  const replacementOwner = agentTerminalOwner(sessionKey, "S2");
  const unrelatedOwner = agentTerminalOwner("agent:main:unrelated", "U1");
  const [oldPty, replacementPty, unrelatedPty] = [makeFakePty(), makeFakePty(), makeFakePty()];
  const drainStarted = createDeferredCore();
  const killOldPty = oldPty.kill.bind(oldPty);
  oldPty.kill = () => {
    killOldPty();
    drainStarted.resolve();
  };
  const manager = new TerminalSessionManager({ emit: vi.fn() });
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(oldOwner.agentSessionId) },
  });
  const [oldSession, replacementSession, unrelatedSession] = await Promise.all([
    manager.open(baseOpenRequest({ owner: oldOwner, createBackend: async () => oldPty })),
    manager.open(
      baseOpenRequest({ owner: replacementOwner, createBackend: async () => replacementPty }),
    ),
    manager.open(
      baseOpenRequest({ owner: unrelatedOwner, createBackend: async () => unrelatedPty }),
    ),
  ]);
  if (!oldSession.ok || !replacementSession.ok || !unrelatedSession.ok) {
    throw new Error("expected terminal sessions");
  }

  let archiveSettled = false;
  const archivePromise = directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: oldOwner.agentSessionId },
    { context: { terminalSessions: manager } },
  ).finally(() => {
    archiveSettled = true;
  });
  onTestFinished(async () => {
    if (!archiveSettled) {
      oldPty.emitExit(0);
    }
    await archivePromise;
    manager.disposeAll();
  });

  // Synchronize on the PTY action itself; cold RPC loading is not lifecycle timing.
  await drainStarted.promise;
  expect(oldPty.killed).toBe(true);
  expect(archiveSettled).toBe(false);
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  oldPty.emitExit(0);
  const archived = await archivePromise;

  expect(archived.ok).toBe(true);
  expect(manager.listAgent(oldOwner)).toEqual([]);
  expect(manager.snapshotAgent(oldOwner, oldSession.sessionId)).toBeUndefined();
  replacementPty.emitData("replacement\n");
  unrelatedPty.emitData("unrelated\n");
  expect(manager.snapshotAgent(replacementOwner, replacementSession.sessionId)).toContain(
    "replacement",
  );
  expect(manager.snapshotAgent(unrelatedOwner, unrelatedSession.sessionId)).toContain("unrelated");
  expect(replacementPty.killed).toBe(false);
  expect(unrelatedPty.killed).toBe(false);
  expect(manager.size).toBe(2);
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
});
