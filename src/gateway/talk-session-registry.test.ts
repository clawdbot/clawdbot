import { describe, expect, it, vi } from "vitest";
import {
  cleanupTalkConnection,
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  registerTalkConnectionCleanup,
  rememberUnifiedTalkSession,
} from "./talk-session-registry.js";

describe("Talk connection cleanup registry", () => {
  it("keeps one cleanup per relay kind and forgets the connection before running them", () => {
    const replacedRealtimeCleanup = vi.fn();
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };
    const realtimeCleanup = vi.fn(() => {
      cleanupTalkConnection("conn-dedupe", log);
    });

    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", replacedRealtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", realtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-dedupe", log);
    cleanupTalkConnection("conn-dedupe", log);

    expect(replacedRealtimeCleanup).not.toHaveBeenCalled();
    expect(realtimeCleanup).toHaveBeenCalledOnce();
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("continues cleanup after one relay owner throws", () => {
    const cleanupError = new Error("realtime cleanup failed");
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup("conn-error", "realtime-relay", () => {
      throw cleanupError;
    });
    registerTalkConnectionCleanup("conn-error", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-error", log);

    expect(log.warn).toHaveBeenCalledWith(
      "failed to run realtime-relay Talk cleanup after connection disconnect: realtime cleanup failed",
    );
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
  });
});

describe("Talk session id lookup trim", () => {
  it("resolves and forgets padded session ids against exact Map keys", () => {
    rememberUnifiedTalkSession("talk-trim-1", {
      kind: "managed-room",
      handoffId: "h1",
      token: "t",
      roomId: "r",
    });
    expect(getUnifiedTalkSession(" talk-trim-1 ").kind).toBe("managed-room");
    forgetUnifiedTalkSession(" talk-trim-1 ");
    expect(() => getUnifiedTalkSession("talk-trim-1")).toThrow(/Unknown Talk session/);
  });

  it("talk.session.close lookup path resolves a padded realtime relay id then forgets it", () => {
    // Mirrors talk.session.close: getUnifiedTalkSession → stop → forgetUnifiedTalkSession
    rememberUnifiedTalkSession("relay-close-pad", {
      kind: "realtime-relay",
      connId: "conn-1",
      relaySessionId: "relay-close-pad",
      sessionTarget: {
        agentId: "main",
        canonicalKey: "agent:main:main",
        storeKey: "agent:main:main",
        storePath: "/tmp/unused",
      } as never,
    });
    const session = getUnifiedTalkSession(" relay-close-pad ");
    expect(session.kind).toBe("realtime-relay");
    if (session.kind === "realtime-relay") {
      expect(session.relaySessionId).toBe("relay-close-pad");
      expect(session.connId).toBe("conn-1");
    }
    forgetUnifiedTalkSession(" relay-close-pad ");
    expect(() => getUnifiedTalkSession("relay-close-pad")).toThrow(/Unknown Talk session/);
  });
});
