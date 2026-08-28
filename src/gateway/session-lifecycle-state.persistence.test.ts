import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentLifecycleTerminalBackstop } from "../auto-reply/reply/agent-lifecycle-terminal.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
} from "../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

const routing = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
vi.mock("./session-utils.js", () => ({ loadSessionEntry: routing.loadSessionEntry }));

it("persists current-run timing after pre-start failure and clears it on the next run", async () => {
  const tempDirs = createTempDirTracker();
  const target = {
    storePath: path.join(tempDirs.make("openclaw-lifecycle-timing-"), "sessions.json"),
    sessionKey: "agent:main:timing",
  };
  let now = 1_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  routing.loadSessionEntry.mockImplementation(() => ({
    ...target,
    canonicalKey: target.sessionKey,
    entry: loadSessionEntry(target),
  }));
  let persistence = Promise.resolve();
  const unsubscribe = onAgentEvent((event) => {
    if (event.sessionKey === target.sessionKey && event.stream === "lifecycle") {
      persistence = persistence.then(() =>
        persistGatewaySessionLifecycleEvent({ sessionKey: target.sessionKey, event }),
      );
    }
  });
  const createBackstop = (runId: string) =>
    createAgentLifecycleTerminalBackstop({
      runId,
      sessionKey: target.sessionKey,
      getLifecycleGeneration: getAgentEventLifecycleGeneration,
      resolveTerminationFields: () => ({}),
    });
  const start = (runId: string) => {
    const backstop = createBackstop(runId);
    const data = { phase: "start", startedAt: now };
    emitAgentEvent({ runId, sessionKey: target.sessionKey, stream: "lifecycle", data });
    backstop.note({ stream: "lifecycle", data });
    return backstop;
  };
  try {
    await replaceSessionEntry(target, { sessionId: "timing-session", updatedAt: now });
    const previous = start("timing-persisted-previous");
    now += 11_192;
    previous.emit("end", { meta: {} });
    await persistence;
    expect(loadSessionEntry(target)).toMatchObject({
      status: "done",
      startedAt: 1_000_000,
      runtimeMs: 11_192,
    });

    now = 3_475_979;
    const failed = createBackstop("timing-persisted-failed");
    now += 4_700;
    failed.emit("error", new Error("preparation failed"));
    await persistence;
    expect.soft(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      startedAt: 3_475_979,
      endedAt: 3_480_679,
      runtimeMs: 4_700,
      lastRunError: "preparation failed",
      lastRunId: "timing-persisted-failed",
    });

    now = 3_600_000;
    const recovered = start("timing-persisted-recovered");
    await persistence;
    const running = loadSessionEntry(target);
    expect(running).toMatchObject({ status: "running", startedAt: 3_600_000 });
    expect(running?.runtimeMs).toBeUndefined();
    expect(running?.endedAt).toBeUndefined();
    expect(running?.lastRunError).toBeUndefined();
    now += 11_192;
    recovered.emit("end", { meta: {} });
    await persistence;
    closeOpenClawAgentDatabasesForTest();
    expect(loadSessionEntry(target)).toMatchObject({
      status: "done",
      startedAt: 3_600_000,
      endedAt: 3_611_192,
      runtimeMs: 11_192,
      lastRunId: "timing-persisted-recovered",
    });
  } finally {
    unsubscribe();
    await persistence;
    clock.mockRestore();
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});
