import { describe, expect, it, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../packages/gateway-protocol/src/index.js";
import { SessionCompanionAskError } from "./session-companion-ask.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";

async function invoke(
  method: keyof typeof sessionCompanionHandlers,
  params: unknown,
  companion: {
    ask?: ReturnType<typeof vi.fn>;
    state?: ReturnType<typeof vi.fn>;
    reset?: ReturnType<typeof vi.fn>;
  },
  client: { connId?: string } = { connId: "conn-1" },
  signal?: AbortSignal,
  config: Record<string, unknown> = { agents: { list: [{ id: "main" }] } },
) {
  const respond = vi.fn();
  await sessionCompanionHandlers[method]?.({
    params,
    client,
    context: { sessionCompanion: companion, getRuntimeConfig: () => config },
    respond,
    signal,
  } as never);
  return respond;
}

describe("session companion RPC", () => {
  it("dispatches a valid ask and returns its timestamp", async () => {
    const ask = vi.fn(async () => ({ answer: "It is checking the fix.", ts: 123 }));
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "What is happening?" },
      { ask },
    );

    expect(ask).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      question: "What is happening?",
      connId: "conn-1",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      answer: "It is checking the fix.",
      ts: 123,
    });
  });

  it("forwards the authenticated request lifetime and emits one final response", async () => {
    const controller = new AbortController();
    const ask = vi.fn(async () => ({ answer: "Bound to this connection.", ts: 124 }));
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Who owns this ask?" },
      { ask },
      { connId: "conn-1" },
      controller.signal,
    );

    expect(ask).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      question: "Who owns this ask?",
      connId: "conn-1",
      signal: controller.signal,
    });
    expect(respond.mock.calls).toEqual([[true, { answer: "Bound to this connection.", ts: 124 }]]);
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
    expect(state).toHaveBeenCalledWith({ agentId: "main", sessionKey: "agent:main:main" });
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
    expect(reset).toHaveBeenCalledWith({ agentId: "main", sessionKey: "agent:main:main" });
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

  it("threads an explicit owner for a bare key and returns typed selection errors", async () => {
    const config = { agents: { ownership: "explicit", list: [{ id: "main" }, { id: "work" }] } };
    const state = vi.fn(() => ({ exchanges: [] }));
    const selected = await invoke(
      "sessions.companion.state",
      { sessionKey: "global", agentId: "work" },
      { state },
      undefined,
      undefined,
      config,
    );
    expect(state).toHaveBeenCalledWith({ agentId: "work", sessionKey: "global" });
    expect(selected).toHaveBeenCalledWith(true, { exchanges: [] });

    state.mockClear();
    const ambiguous = await invoke(
      "sessions.companion.state",
      { sessionKey: "global" },
      { state },
      undefined,
      undefined,
      config,
    );
    expect(state).not.toHaveBeenCalled();
    expect(ambiguous).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
