import { describe, expect, it } from "vitest";
import {
  abortQueuedChatTurnById,
  abortQueuedChatTurns,
  completeQueuedChatTurn,
  listQueuedChatTurnsForSession,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnMap,
} from "./chat-queued-turns.js";

function emptyMap(): QueuedChatTurnMap {
  return new Map();
}

function registerTurn(
  map: QueuedChatTurnMap,
  runId: string,
  controller: AbortController,
  sessionId = runId,
): boolean {
  return registerQueuedChatTurn({
    chatQueuedTurns: map,
    runId,
    controller,
    sessionId,
    sessionKey: "main",
  });
}

describe("chat-queued-turns", () => {
  it("registers and completes a queued turn", () => {
    const map = emptyMap();
    const controller = new AbortController();
    expect(
      registerQueuedChatTurn({
        chatQueuedTurns: map,
        runId: "run-a",
        controller,
        sessionId: "sess-a",
        sessionKey: "main",
        ownerConnId: "conn-1",
        ownerDeviceId: "dev-1",
      }),
    ).toBe(true);
    expect(map.get("run-a")?.sessionKey).toBe("main");
    expect(completeQueuedChatTurn(map, "run-a", controller)).toBe(true);
    expect(map.get("run-a")).toBeUndefined();
  });

  it("removes the queued entry when its controller aborts", () => {
    const map = emptyMap();
    const controller = new AbortController();
    expect(registerTurn(map, "run-abort", controller, "sess-abort")).toBe(true);

    controller.abort();

    expect(map.get("run-abort")).toBeUndefined();
  });

  it("does not let a stale abort listener remove a reused run id", () => {
    const map = emptyMap();
    const first = new AbortController();
    const second = new AbortController();
    expect(registerTurn(map, "run-reused", first, "sess-a")).toBe(true);
    expect(completeQueuedChatTurn(map, "run-reused", first)).toBe(true);
    expect(registerTurn(map, "run-reused", second, "sess-b")).toBe(true);

    first.abort();

    expect(map.get("run-reused")?.controller).toBe(second);
    second.abort();
    expect(map.get("run-reused")).toBeUndefined();
  });

  it("does not let stale lifecycle callbacks mutate a reused run id", () => {
    const map = emptyMap();
    const first = new AbortController();
    const second = new AbortController();
    expect(registerTurn(map, "run-reused", first, "sess-a")).toBe(true);

    first.abort();
    expect(registerTurn(map, "run-reused", second, "sess-b")).toBe(true);

    expect(retireQueuedChatTurnCancellation(map, "run-reused", first)).toBe(false);
    expect(completeQueuedChatTurn(map, "run-reused", first)).toBe(false);
    const current = map.get("run-reused");
    expect(current?.controller).toBe(second);
    expect(current?.abortable).toBeUndefined();
  });

  it.each(["single", "bulk"] as const)(
    "preserves a synchronous replacement during %s abort cleanup",
    (mode) => {
      const map = emptyMap();
      const first = new AbortController();
      const second = new AbortController();
      expect(registerTurn(map, "run-replaced", first, "sess-a")).toBe(true);
      const firstEntry = map.get("run-replaced");
      expect(firstEntry).toBeDefined();
      first.signal.addEventListener(
        "abort",
        () => {
          expect(registerTurn(map, "run-replaced", second, "sess-b")).toBe(true);
        },
        { once: true },
      );

      const aborted =
        mode === "single"
          ? abortQueuedChatTurnById(map, {
              runId: "run-replaced",
              sessionKey: "main",
            }).aborted
          : abortQueuedChatTurns(map, [{ runId: "run-replaced", entry: firstEntry! }]).includes(
              "run-replaced",
            );

      expect(aborted).toBe(true);
      expect(map.get("run-replaced")?.controller).toBe(second);
    },
  );

  it("keeps retired collect identities until completion after abort", () => {
    const map = emptyMap();
    const controller = new AbortController();
    expect(registerTurn(map, "run-retired", controller, "sess-retired")).toBe(true);
    expect(retireQueuedChatTurnCancellation(map, "run-retired", controller)).toBe(true);

    controller.abort();

    expect(map.get("run-retired")?.abortable).toBe(false);
    expect(completeQueuedChatTurn(map, "run-retired", controller)).toBe(true);
    expect(map.get("run-retired")).toBeUndefined();
  });

  it("rejects re-register with a different controller", () => {
    const map = emptyMap();
    const first = new AbortController();
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "run-a",
      controller: first,
      sessionId: "sess-a",
      sessionKey: "main",
    });
    expect(
      registerQueuedChatTurn({
        chatQueuedTurns: map,
        runId: "run-a",
        controller: new AbortController(),
        sessionId: "sess-a",
        sessionKey: "main",
      }),
    ).toBe(false);
  });

  it("preserves whitespace-distinct protocol run IDs", () => {
    const map = emptyMap();
    const spaced = new AbortController();
    const plain = new AbortController();
    expect(
      registerQueuedChatTurn({
        chatQueuedTurns: map,
        runId: " run-a ",
        controller: spaced,
        sessionId: "sess-a",
        sessionKey: "main",
      }),
    ).toBe(true);
    expect(
      registerQueuedChatTurn({
        chatQueuedTurns: map,
        runId: "run-a",
        controller: plain,
        sessionId: "sess-a",
        sessionKey: "main",
      }),
    ).toBe(true);

    expect(map.get(" run-a ")?.controller).toBe(spaced);
    expect(abortQueuedChatTurnById(map, { runId: " run-a ", sessionKey: "main" }).aborted).toBe(
      true,
    );
    expect(map.has("run-a")).toBe(true);
    expect(plain.signal.aborted).toBe(false);
  });

  it("aborts by runId and removes the entry", () => {
    const map = emptyMap();
    const controller = new AbortController();
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "run-b",
      controller,
      sessionId: "sess-b",
      sessionKey: "main",
    });
    const res = abortQueuedChatTurnById(map, {
      runId: "run-b",
      sessionKey: "main",
      stopReason: "rpc",
    });
    expect(res.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(map.has("run-b")).toBe(false);
  });

  it("retains a retired collect source identity until aggregate completion", () => {
    const map = emptyMap();
    const controller = new AbortController();
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "run-collected",
      controller,
      sessionId: "sess-collected",
      sessionKey: "main",
    });

    expect(retireQueuedChatTurnCancellation(map, "run-collected", controller)).toBe(true);
    expect(
      abortQueuedChatTurnById(map, { runId: "run-collected", sessionKey: "main" }).aborted,
    ).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(map.has("run-collected")).toBe(true);
    expect(listQueuedChatTurnsForSession({ chatQueuedTurns: map, sessionKeys: ["main"] })).toEqual(
      [],
    );
    expect(completeQueuedChatTurn(map, "run-collected", controller)).toBe(true);
  });

  it("refuses abort when sessionKey mismatches unless allowed", () => {
    const map = emptyMap();
    const controller = new AbortController();
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "run-c",
      controller,
      sessionId: "sess-c",
      sessionKey: "main",
    });
    expect(abortQueuedChatTurnById(map, { runId: "run-c", sessionKey: "other" }).aborted).toBe(
      false,
    );
    expect(controller.signal.aborted).toBe(false);
    expect(
      abortQueuedChatTurnById(map, {
        runId: "run-c",
        sessionKey: "other",
        allowSessionMismatch: true,
      }).aborted,
    ).toBe(true);
  });

  it("lists session matches and supports global agent scoping", () => {
    const map = emptyMap();
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "g-main",
      controller: new AbortController(),
      sessionId: "s1",
      sessionKey: "global",
      agentId: "main",
    });
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "g-other",
      controller: new AbortController(),
      sessionId: "s2",
      sessionKey: "global",
      agentId: "other",
    });
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "local",
      controller: new AbortController(),
      sessionId: "s3",
      sessionKey: "agent:main:main",
    });
    const globalMain = listQueuedChatTurnsForSession({
      chatQueuedTurns: map,
      sessionKeys: ["global"],
      agentId: "main",
      defaultAgentId: "main",
    });
    expect(globalMain.map((m) => m.runId).toSorted()).toEqual(["g-main"]);
    const local = listQueuedChatTurnsForSession({
      chatQueuedTurns: map,
      sessionKeys: ["agent:main:main"],
    });
    expect(local.map((m) => m.runId)).toEqual(["local"]);
  });

  it("aborts authorized matches before returning runIds", () => {
    const map = emptyMap();
    const a = new AbortController();
    const b = new AbortController();
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "qa",
      controller: a,
      sessionId: "s",
      sessionKey: "main",
    });
    registerQueuedChatTurn({
      chatQueuedTurns: map,
      runId: "qb",
      controller: b,
      sessionId: "s",
      sessionKey: "main",
    });
    const matches = listQueuedChatTurnsForSession({
      chatQueuedTurns: map,
      sessionKeys: ["main"],
    });
    const runIds = abortQueuedChatTurns(map, matches, "rpc");
    expect(runIds.toSorted()).toEqual(["qa", "qb"]);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(map.size).toBe(0);
  });
});
