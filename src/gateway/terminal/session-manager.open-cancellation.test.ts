import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./session-manager.js";
import {
  baseOpenRequest as baseRequest,
  type FakeTerminalPty,
  makeFakePty,
} from "./session-manager.test-helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("TerminalSessionManager open cancellation", () => {
  it("kills a backend that finishes after its open request is cancelled", async () => {
    const spawned = deferred<FakeTerminalPty>();
    const controller = new AbortController();
    const first = makeFakePty();
    const second = makeFakePty();
    let spawnCount = 0;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      maxSessions: 1,
      spawn: () => (spawnCount++ === 0 ? spawned.promise : Promise.resolve(second)),
    });
    const opening = manager.open(baseRequest({ signal: controller.signal }));

    controller.abort(new Error("terminal open timed out"));
    const next = await manager.open(baseRequest({ owner: { kind: "conn", connId: "conn-2" } }));
    expect(next.ok).toBe(true);
    spawned.resolve(first);

    await expect(opening).resolves.toEqual({
      ok: false,
      code: "closed",
      message: "terminal open timed out",
    });
    expect(first.killed).toBe(true);
    expect(manager.size).toBe(1);
    if (next.ok) {
      expect(manager.close("conn-2", next.sessionId)).toBe(true);
    }
    expect(second.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("bounds cancelled backend operations until they settle", async () => {
    const firstSpawn = deferred<FakeTerminalPty>();
    const secondSpawn = deferred<FakeTerminalPty>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let spawnCount = 0;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      maxSessions: 1,
      spawn: () => (spawnCount++ === 0 ? firstSpawn.promise : secondSpawn.promise),
    });

    const firstOpening = manager.open(baseRequest({ signal: firstController.signal }));
    firstController.abort(new Error("first cancelled"));
    const secondOpening = manager.open(
      baseRequest({ owner: { kind: "conn", connId: "conn-2" }, signal: secondController.signal }),
    );
    secondController.abort(new Error("second cancelled"));

    await expect(
      manager.open(baseRequest({ owner: { kind: "conn", connId: "conn-3" } })),
    ).resolves.toEqual({
      ok: false,
      code: "limit",
      message: "terminal spawn limit reached (2)",
    });

    const first = makeFakePty();
    const second = makeFakePty();
    firstSpawn.resolve(first);
    secondSpawn.resolve(second);
    await expect(firstOpening).resolves.toMatchObject({ ok: false, code: "closed" });
    await expect(secondOpening).resolves.toMatchObject({ ok: false, code: "closed" });
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
  });
});
