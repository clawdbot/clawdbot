/**
 * Regression coverage for #120488: a terminal `process poll` must consume the
 * queued exec-completion notification so the next heartbeat does not relay it
 * as a stale duplicate.
 */
import { afterEach, expect, test } from "vitest";
import { resolveEventSessionKeyForPolicy } from "../infra/event-session-routing.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  getFinishedSession,
  markExited,
  recordExecCompletionNotify,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  resetDiagnosticSessionStateForTest();
});

function createBackgroundedSession(params: { id: string; sessionKey?: string }) {
  const session = createProcessSessionFixture({
    id: params.id,
    command: "test",
    backgrounded: true,
  });
  if (params.sessionKey) {
    session.sessionKey = params.sessionKey;
  }
  addSession(session);
  return session;
}

test("terminal process poll consumes the queued exec-completion notification", async () => {
  const session = createBackgroundedSession({ id: "poll-ack", sessionKey: "agent:main:test" });
  const eventSessionKey = resolveEventSessionKeyForPolicy("agent:main:test", undefined);
  const notifyEvent = enqueueSystemEventEntry("Exec completed (poll-ack, code 0) :: done", {
    sessionKey: eventSessionKey,
  });
  expect(notifyEvent).not.toBeNull();
  recordExecCompletionNotify(session, notifyEvent!, eventSessionKey);
  expect(peekSystemEventEntries(eventSessionKey)).toHaveLength(1);

  appendOutput(session, "stdout", "done\n");
  markExited(session, 0, null, "completed");

  const processTool = createProcessTool();
  const poll = await processTool.execute("poll-ack-call", {
    action: "poll",
    sessionId: "poll-ack",
  });
  expect(poll.details).toMatchObject({ status: "completed" });

  // The queued notification was consumed by the terminal poll; the heartbeat
  // must not relay a stale duplicate later.
  expect(peekSystemEventEntries(eventSessionKey)).toHaveLength(0);
  expect(getFinishedSession("poll-ack")?.notifyEvent).toBeUndefined();
  expect(getFinishedSession("poll-ack")?.notifyEventSessionKey).toBeUndefined();
});

test("process poll on a still-running session keeps the queued notification", async () => {
  const session = createBackgroundedSession({ id: "poll-running", sessionKey: "agent:main:test" });
  const eventSessionKey = resolveEventSessionKeyForPolicy("agent:main:test", undefined);
  const notifyEvent = enqueueSystemEventEntry("Exec completed (poll-running, code 0) :: done", {
    sessionKey: eventSessionKey,
  });
  recordExecCompletionNotify(session, notifyEvent!, eventSessionKey);

  appendOutput(session, "stdout", "partial\n");
  const processTool = createProcessTool();
  const poll = await processTool.execute("poll-running-call", {
    action: "poll",
    sessionId: "poll-running",
  });
  expect(poll.details).toMatchObject({ status: "running" });

  // Not consumed: the process has not reached a terminal state yet.
  expect(peekSystemEventEntries(eventSessionKey)).toHaveLength(1);
  expect(session.notifyEvent).toBeDefined();
});

test("poll on an already-finished session consumes the notification recorded on the finished record", async () => {
  const session = createBackgroundedSession({ id: "poll-finished", sessionKey: "agent:main:test" });
  const eventSessionKey = resolveEventSessionKeyForPolicy("agent:main:test", undefined);
  const notifyEvent = enqueueSystemEventEntry(
    "Exec failed (poll-finished, signal SIGKILL) :: boom",
    {
      sessionKey: eventSessionKey,
    },
  );
  recordExecCompletionNotify(session, notifyEvent!, eventSessionKey);
  appendOutput(session, "stderr", "boom\n");
  markExited(session, null, "SIGKILL", "failed");

  // The finished record carries the notification so a later poll can consume it.
  const processTool = createProcessTool();
  const poll = await processTool.execute("poll-finished-call", {
    action: "poll",
    sessionId: "poll-finished",
  });
  expect(poll.details).toMatchObject({ status: "failed" });
  expect(peekSystemEventEntries(eventSessionKey)).toHaveLength(0);
});

test("consumeSelectedSystemEventEntries removes only the matching exec-completion event", () => {
  const sessionKey = "agent:main:test";
  enqueueSystemEventEntry("Exec completed (other, code 0) :: unrelated", { sessionKey });
  const target = enqueueSystemEventEntry("Exec completed (target, code 0) :: done", { sessionKey });

  const removed = consumeSelectedSystemEventEntries(sessionKey, [target!]);
  expect(removed).toHaveLength(1);
  expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
    "Exec completed (other, code 0) :: unrelated",
  ]);
});
