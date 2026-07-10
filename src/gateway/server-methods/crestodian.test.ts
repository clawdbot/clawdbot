// Crestodian gateway tests cover activation serialization and chat sessions.
import { describe, expect, it, vi } from "vitest";
import { CrestodianChatEngine } from "../../crestodian/chat-engine.js";
import { createDeferred } from "../../test-utils/deferred.js";
import {
  crestodianHandlers,
  runExclusiveCrestodianSetupActivation,
  type CrestodianChatSession,
} from "./crestodian.js";
import type { GatewayRequestContext } from "./types.js";

type RespondCall = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

function makeRespond() {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

function makeContext(sessions: Map<string, CrestodianChatSession>): GatewayRequestContext {
  return { crestodianSessions: sessions } as unknown as GatewayRequestContext;
}

function seededSession(overrides?: Partial<CrestodianChatSession>): CrestodianChatSession {
  return {
    engine: new CrestodianChatEngine({}),
    welcome: "welcome text",
    lastUsedAt: 1,
    ...overrides,
  };
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
): Promise<RespondCall> {
  const { calls, respond } = makeRespond();
  await crestodianHandlers["crestodian.chat"]({
    params,
    respond,
    context,
  } as never);
  const call = calls[0];
  if (!call) {
    throw new Error("expected a respond call");
  }
  return call;
}

describe("crestodian.setup.activate", () => {
  it("rejects a concurrent activation instead of queueing stale work", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];

    const first = runExclusiveCrestodianSetupActivation(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstStarted.promise;

    const secondTask = vi.fn(async () => {
      events.push("second:start");
      events.push("second:end");
    });
    const second = runExclusiveCrestodianSetupActivation(secondTask);

    expect(events).toEqual(["first:start"]);
    await expect(second).rejects.toThrow("setup is already in progress");
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    expect(events).toEqual(["first:start", "first:end"]);

    await runExclusiveCrestodianSetupActivation(async () => {
      events.push("third:start");
    });
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });

  it("returns a retryable busy error while another activation is running", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const first = runExclusiveCrestodianSetupActivation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    try {
      const { calls, respond } = makeRespond();
      await crestodianHandlers["crestodian.setup.activate"]({
        params: { kind: "claude-cli" },
        respond,
      } as never);

      expect(calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "UNAVAILABLE",
            message: "Crestodian setup is already in progress; try again when it finishes.",
            retryable: true,
          },
        },
      ]);
    } finally {
      releaseFirst.resolve();
      await first;
    }
  });

  it("releases the activation slot when the owning task fails", async () => {
    await expect(
      runExclusiveCrestodianSetupActivation(async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    const nextTask = vi.fn(async () => "ok");
    await expect(runExclusiveCrestodianSetupActivation(nextTask)).resolves.toBe("ok");
    expect(nextTask).toHaveBeenCalledOnce();
  });
});

describe("crestodian.chat", () => {
  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it("returns the stored welcome when no message is sent", async () => {
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession()]]);
    const call = await callChat(makeContext(sessions), { sessionId: "s1" });
    expect(call.ok).toBe(true);
    expect(call.payload).toMatchObject({ sessionId: "s1", reply: "welcome text", action: "none" });
  });

  it("routes messages through the session engine", async () => {
    const engine = new CrestodianChatEngine({});
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "did the thing", action: "none" });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "status" });

    expect(handle).toHaveBeenCalledWith("status");
    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
  });

  it("forwards sensitive-input metadata to clients", async () => {
    const engine = new CrestodianChatEngine({});
    vi.spyOn(engine, "handle").mockResolvedValue({
      text: "Enter the bot token",
      action: "none",
      sensitive: true,
    });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({ sensitive: true });
  });

  it("maps the TUI handoff to an open-agent action for clients", async () => {
    const engine = new CrestodianChatEngine({});
    vi.spyOn(engine, "handle").mockResolvedValue({
      text: "",
      action: "open-tui",
      handoff: { kind: "open-tui" },
    });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "talk to agent",
    });

    expect(call.payload).toMatchObject({ action: "open-agent" });
    expect((call.payload as { reply: string }).reply).toContain("continue with your agent");
  });

  it("resets a session on request", async () => {
    const engine = new CrestodianChatEngine({});
    const handle = vi.spyOn(engine, "handle");
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);
    // Reset drops the stored session; loading a fresh welcome would hit real
    // discovery, so stub the overview loader on the replacement engine path by
    // asserting the old engine is gone instead.
    const { calls, respond } = makeRespond();
    const context = makeContext(sessions);
    const pending = crestodianHandlers["crestodian.chat"]({
      params: { sessionId: "s1", reset: true },
      respond,
      context,
    } as never);
    await pending;
    expect(handle).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(calls[0]?.ok).toBe(true);
  });
});
