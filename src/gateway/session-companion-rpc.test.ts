import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { GatewayErrorDetailCodes } from "../../packages/gateway-protocol/src/index.js";
import { SessionCompanionAskError } from "./session-companion-ask.js";
import {
  notifySessionCompanionPrepared,
  registerSessionCompanionProgress,
} from "./session-companion-progress.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";

async function invoke(
  method: keyof typeof sessionCompanionHandlers,
  params: unknown,
  companion: {
    ask?: ReturnType<typeof vi.fn>;
    state?: ReturnType<typeof vi.fn>;
    reset?: ReturnType<typeof vi.fn>;
  },
  client: { connId?: string; connect?: { caps?: string[] } } = {
    connId: "conn-1",
    connect: { caps: [] },
  },
) {
  const respond = vi.fn();
  await sessionCompanionHandlers[method]?.({
    params,
    client,
    context: { sessionCompanion: companion },
    respond,
  } as never);
  return respond;
}

describe("session companion RPC", () => {
  it("keeps the first progress owner and isolates callback failures", () => {
    const first = vi.fn(() => {
      throw new Error("presentation failed");
    });
    const second = vi.fn();
    const clearFirst = registerSessionCompanionProgress({
      connId: "conn-1",
      sessionKey: "agent:main:main",
      listener: first,
    });
    const clearSecond = registerSessionCompanionProgress({
      connId: "conn-1",
      sessionKey: "agent:main:main",
      listener: second,
    });

    expect(() =>
      notifySessionCompanionPrepared({
        connId: "conn-1",
        empty: false,
        sessionKey: "agent:main:main",
      }),
    ).not.toThrow();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    clearSecond();
    clearFirst();
  });

  it("dispatches a valid ask and returns its timestamp", async () => {
    const ask = vi.fn(async () => ({ answer: "It is checking the fix.", ts: 123 }));
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "What is happening?" },
      { ask },
    );

    expect(ask).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      question: "What is happening?",
      connId: "conn-1",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      answer: "It is checking the fix.",
      ts: 123,
    });
  });

  it("emits progress only after context is ready, then returns the answer", async () => {
    const ask = vi.fn(async () => {
      notifySessionCompanionPrepared({
        connId: "conn-1",
        empty: false,
        sessionKey: "agent:main:main",
      });
      return { answer: "It is checking the fix.", ts: 123 };
    });
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "What is happening?" },
      { ask },
      {
        connId: "conn-1",
        connect: { caps: [GATEWAY_CLIENT_CAPS.SESSION_COMPANION_PROGRESS] },
      },
    );

    expect(ask).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      question: "What is happening?",
      connId: "conn-1",
    });
    expect(respond.mock.calls).toEqual([
      [true, { status: "accepted", empty: false }],
      [true, { answer: "It is checking the fix.", ts: 123 }],
    ]);
  });

  it.each([
    {},
    { sessionKey: "", question: "why" },
    { sessionKey: "agent:main:main", question: "" },
    { sessionKey: "agent:main:main", question: "why", extra: true },
  ])("rejects invalid ask params %#", async (params) => {
    const ask = vi.fn();
    const respond = await invoke("sessions.companion.ask", params, { ask });
    expect(ask).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("requires a connected client for asks", async () => {
    const ask = vi.fn();
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Why?" },
      { ask },
      {},
    );
    expect(ask).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("returns the typed retryable busy detail", async () => {
    const ask = vi.fn(async () => {
      throw new SessionCompanionAskError("busy", "Already answering.");
    });
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Why?" },
      { ask },
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: { code: GatewayErrorDetailCodes.SESSION_COMPANION_BUSY },
      }),
    );
  });

  it("returns a retryable typed context-read failure", async () => {
    const ask = vi.fn(async () => {
      throw new SessionCompanionAskError(
        "context-unavailable",
        "The selected session history could not be loaded.",
      );
    });
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Why?" },
      { ask },
      {
        connId: "conn-1",
        connect: { caps: [GATEWAY_CLIENT_CAPS.SESSION_COMPANION_PROGRESS] },
      },
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: { reason: "context-unavailable" },
      }),
    );
  });

  it("returns and validates per-session state", async () => {
    const state = vi.fn(() => ({
      exchanges: [{ question: "Why?", answer: "Because.", ts: 10 }],
    }));
    const respond = await invoke(
      "sessions.companion.state",
      { sessionKey: "agent:main:main" },
      { state },
    );
    expect(state).toHaveBeenCalledWith("agent:main:main");
    expect(respond).toHaveBeenCalledWith(true, {
      exchanges: [{ question: "Why?", answer: "Because.", ts: 10 }],
    });

    const invalid = await invoke("sessions.companion.state", {}, { state });
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("resets and validates one session thread", async () => {
    const reset = vi.fn();
    const respond = await invoke(
      "sessions.companion.reset",
      { sessionKey: "agent:main:main" },
      { reset },
    );
    expect(reset).toHaveBeenCalledWith("agent:main:main");
    expect(respond).toHaveBeenCalledWith(true, { ok: true });

    const invalid = await invoke(
      "sessions.companion.reset",
      { sessionKey: "agent:main:main", extra: true },
      { reset },
    );
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
