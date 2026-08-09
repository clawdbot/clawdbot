import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./session-manager.js";
import { baseOpenRequest, makeFakePty } from "./session-manager.test-helpers.js";

const TERMINAL_EVENT_EXIT = "terminal.exit";

describe("TerminalSessionManager task lifecycle", () => {
  it("closes one task owner with viewer cleanup while preserving persistent owners", async () => {
    const emit = vi.fn();
    const runPtys = [makeFakePty(), makeFakePty()];
    const persistentPty = makeFakePty();
    const connectionPty = makeFakePty();
    const ptys = [...runPtys, persistentPty, connectionPty];
    let spawnIndex = 0;
    const manager = new TerminalSessionManager({
      emit,
      spawn: async () => expectDefined(ptys[spawnIndex++], "terminal PTY test invariant"),
    });
    const runOwner = {
      kind: "agent",
      agentSessionKey: "agent:main:cron:job-1:run:run-1",
      taskId: "task-1",
    } as const;
    const persistentOwner = { kind: "agent", agentSessionKey: "agent:main:main" } as const;
    const first = await manager.open(baseOpenRequest({ owner: runOwner }));
    const second = await manager.open(baseOpenRequest({ owner: runOwner }));
    const persistent = await manager.open(baseOpenRequest({ owner: persistentOwner }));
    const connection = await manager.open(
      baseOpenRequest({ owner: { kind: "conn", connId: "connection-owner" } }),
    );
    if (!first.ok || !second.ok || !persistent.ok || !connection.ok) {
      throw new Error("expected terminal sessions");
    }
    manager.attach("viewer-1", first.sessionId);
    manager.attach("viewer-2", second.sessionId);
    emit.mockClear();

    expect(manager.closeAgentSessions(runOwner.taskId)).toBe(2);
    expect(runPtys.every((pty) => pty.killed)).toBe(true);
    expect(persistentPty.killed).toBe(false);
    expect(connectionPty.killed).toBe(false);
    expect(manager.listAgent(runOwner.agentSessionKey)).toEqual([]);
    expect(manager.listAgent(persistentOwner.agentSessionKey)).toHaveLength(1);
    expect(manager.write("connection-owner", connection.sessionId, "still live\n")).toBe(true);
    expect(emit).toHaveBeenCalledWith("viewer-1", TERMINAL_EVENT_EXIT, {
      sessionId: first.sessionId,
      exitCode: null,
      signal: null,
      reason: "closed",
    });
    expect(emit).toHaveBeenCalledWith("viewer-2", TERMINAL_EVENT_EXIT, {
      sessionId: second.sessionId,
      exitCode: null,
      signal: null,
      reason: "closed",
    });
    manager.handleDisconnect("viewer-1");
    manager.handleDisconnect("viewer-2");
    expect(manager.size).toBe(2);
  });
});
