import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
  taskAgentOwner,
} from "./session-manager.test-helpers.js";

const TERMINAL_EVENT_EXIT = "terminal.exit";

describe("TerminalSessionManager task lifecycle", () => {
  it("aborts a matching pending task open and kills its late backend", async () => {
    let resolveSpawn!: (pty: ReturnType<typeof makeFakePty>) => void;
    const spawn = new Promise<ReturnType<typeof makeFakePty>>((resolve) => {
      resolveSpawn = resolve;
    });
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: () => spawn });
    const opening = manager.open(
      baseOpenRequest({
        owner: taskAgentOwner("agent:main:cron:job-1:run:run-1", "task-1"),
      }),
    );

    expect(manager.closeTaskSessions("task-1")).toBe(0);
    const latePty = makeFakePty();
    resolveSpawn(latePty);

    await expect(opening).resolves.toEqual({
      ok: false,
      code: "closed",
      message: "terminal closed because its task ended",
    });
    expect(latePty.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("does not authorize interactive access through a colliding task id", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => fake });
    const owner = {
      ...agentTerminalOwner("agent:ops:main", "ops-session", "ops"),
      taskId: "agent:research:main",
    } as const;
    const opened = await manager.open(baseOpenRequest({ owner }));
    if (!opened.ok) {
      throw new Error("expected terminal session");
    }

    const collidingOwner = agentTerminalOwner(
      "agent:research:main",
      "research-session",
      "research",
    );
    expect(manager.writeAgent(collidingOwner, opened.sessionId, "nope")).toEqual({
      ok: false,
      code: "session_unavailable",
    });
    expect(manager.resizeAgent(collidingOwner, opened.sessionId, 90, 30)).toEqual({
      ok: false,
      code: "session_unavailable",
    });
    expect(manager.snapshotAgent(collidingOwner, opened.sessionId)).toBeUndefined();
    expect(manager.closeAgent(collidingOwner, opened.sessionId)).toEqual({
      ok: false,
      code: "session_unavailable",
    });
    expect(fake.killed).toBe(false);
  });

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
      ...agentTerminalOwner("agent:main:cron:job-1:run:run-1", "run-session"),
      taskId: "task-1",
    } as const;
    const persistentOwner = agentTerminalOwner("agent:main:main", "main-session");
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

    expect(manager.closeTaskSessions(runOwner.taskId)).toBe(2);
    expect(runPtys.every((pty) => pty.killed)).toBe(true);
    expect(persistentPty.killed).toBe(false);
    expect(connectionPty.killed).toBe(false);
    expect(manager.listAgent(runOwner)).toEqual([]);
    expect(manager.listAgent(persistentOwner)).toHaveLength(1);
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

  it("drains one agent incarnation while admitting its same-key replacement", async () => {
    const oldPty = makeFakePty();
    const pendingPty = makeFakePty();
    let resolvePending!: (pty: ReturnType<typeof makeFakePty>) => void;
    const pendingBackend = new Promise<ReturnType<typeof makeFakePty>>((resolve) => {
      resolvePending = resolve;
    });
    const replacementPtys = [makeFakePty(), makeFakePty()];
    let spawnIndex = 0;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => replacementPtys[spawnIndex++] ?? makeFakePty(),
    });
    const oldOwner = agentTerminalOwner("agent:main:archive-target", "old-session");
    const replacementOwner = agentTerminalOwner("agent:main:archive-target", "replacement-session");
    const opened = await manager.open(
      baseOpenRequest({ owner: oldOwner, createBackend: async () => oldPty }),
    );
    if (!opened.ok) {
      throw new Error("expected terminal session");
    }
    const pending = manager.open(
      baseOpenRequest({ owner: oldOwner, createBackend: () => pendingBackend }),
    );

    const drain = manager.beginAgentSessionDrain(oldOwner);
    expect(oldPty.killed).toBe(true);
    expect(drain.hasWork()).toBe(true);
    resolvePending(pendingPty);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "closed" });
    expect(pendingPty.killed).toBe(true);
    expect(drain.hasWork()).toBe(true);
    oldPty.emitExit(0);
    expect(drain.hasWork()).toBe(true);
    pendingPty.emitExit(0);
    await expect(drain.drained).resolves.toBeUndefined();
    expect(drain.hasWork()).toBe(false);
    await expect(manager.open(baseOpenRequest({ owner: oldOwner }))).resolves.toMatchObject({
      ok: false,
      code: "closed",
    });
    await expect(manager.open(baseOpenRequest({ owner: replacementOwner }))).resolves.toMatchObject(
      {
        ok: true,
      },
    );

    drain.release();
    await expect(manager.open(baseOpenRequest({ owner: oldOwner }))).resolves.toMatchObject({
      ok: true,
    });
  });
});
