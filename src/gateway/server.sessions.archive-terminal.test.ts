// Archive terminal tests protect exact durable-session ownership at the RPC boundary.
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
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
  const ptys = [oldPty, replacementPty, unrelatedPty];
  const manager = new TerminalSessionManager({
    emit: vi.fn(),
    spawn: async () => ptys.shift() ?? oldPty,
  });
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(oldOwner.agentSessionId) },
  });
  const [oldSession, replacementSession, unrelatedSession] = await Promise.all([
    manager.open(baseOpenRequest({ owner: oldOwner })),
    manager.open(baseOpenRequest({ owner: replacementOwner })),
    manager.open(baseOpenRequest({ owner: unrelatedOwner })),
  ]);
  if (!oldSession.ok || !replacementSession.ok || !unrelatedSession.ok) {
    throw new Error("expected terminal sessions");
  }

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: oldOwner.agentSessionId },
    { context: { terminalSessions: manager } },
  );

  expect(archived.ok).toBe(true);
  expect(oldPty.killed).toBe(true);
  expect(manager.listAgent(oldOwner)).toEqual([]);
  expect(manager.writeAgent(oldOwner, oldSession.sessionId, "stale")).toBe(false);
  expect(manager.writeAgent(replacementOwner, replacementSession.sessionId, "replacement")).toBe(
    true,
  );
  expect(manager.writeAgent(unrelatedOwner, unrelatedSession.sessionId, "unrelated")).toBe(true);
  expect(replacementPty).toMatchObject({ killed: false, writes: ["replacement"] });
  expect(unrelatedPty).toMatchObject({ killed: false, writes: ["unrelated"] });
  expect(manager.size).toBe(2);
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  manager.disposeAll();
});
