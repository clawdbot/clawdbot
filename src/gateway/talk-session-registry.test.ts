import { describe, expect, it, vi } from "vitest";
import { cleanupTalkConnection, registerTalkConnectionCleanup } from "./talk-session-registry.js";

describe("Talk connection cleanup registry", () => {
  it("forgets a kind after its final owner releases it", () => {
    const cleanup = vi.fn();
    const log = { warn: vi.fn() };
    const releaseFirst = registerTalkConnectionCleanup("conn-release", "realtime-relay", cleanup);
    const releaseSecond = registerTalkConnectionCleanup("conn-release", "realtime-relay", cleanup);

    releaseFirst();
    releaseFirst();
    releaseSecond();
    cleanupTalkConnection("conn-release", log);

    expect(cleanup).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

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
