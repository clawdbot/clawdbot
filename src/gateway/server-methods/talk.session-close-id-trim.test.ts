import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
} from "../talk-session-registry.js";
import { talkSessionHandlers } from "./talk-session.js";

const stopTalkRealtimeRelaySession = vi.fn();

vi.mock("../talk-realtime-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../talk-realtime-relay.js")>();
  return {
    ...actual,
    stopTalkRealtimeRelaySession: (...args: unknown[]) => stopTalkRealtimeRelaySession(...args),
  };
});

afterEach(() => {
  stopTalkRealtimeRelaySession.mockReset();
  try {
    forgetUnifiedTalkSession("relay-pad-1");
  } catch {
    // already forgotten
  }
});

describe("talk.session.close padded sessionId", () => {
  it("closes a live realtime relay when sessionId has surrounding whitespace", async () => {
    rememberUnifiedTalkSession("relay-pad-1", {
      kind: "realtime-relay",
      connId: "conn-pad",
      relaySessionId: "relay-pad-1",
      sessionTarget: {
        agentId: "main",
        canonicalKey: "agent:main:main",
        storeKey: "agent:main:main",
        storePath: "/tmp/unused",
      } as never,
    });
    expect(getUnifiedTalkSession("relay-pad-1").kind).toBe("realtime-relay");

    const respond = vi.fn();
    await talkSessionHandlers["talk.session.close"]!({
      req: { type: "req", id: "1", method: "talk.session.close" },
      params: { sessionId: " relay-pad-1 " },
      client: { connId: "conn-pad" },
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    } as never);

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(stopTalkRealtimeRelaySession).toHaveBeenCalledWith({
      relaySessionId: "relay-pad-1",
      connId: "conn-pad",
    });
    expect(() => getUnifiedTalkSession("relay-pad-1")).toThrow(/Unknown Talk session/);
  });
});
