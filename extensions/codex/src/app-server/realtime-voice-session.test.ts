import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeWebRtcAudioPeerCallbacks,
  RealtimeWebRtcAudioPeerContract,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexAppServerRealtimeVoiceBridge } from "./realtime-voice-session.js";

const RESET_ERROR =
  "stream disconnected before completion: failed to read websocket message: WebSocket protocol error: Connection reset without closing handshake";

function createRequest(): RealtimeVoiceBridgeCreateRequest {
  return {
    providerConfig: { version: "v3", voice: "arbor" },
    instructions: "Use the bound OpenClaw agent.",
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onReady: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    onEvent: vi.fn(),
    onTranscript: vi.fn(),
  };
}

function createPeer() {
  return {
    adoptPendingAudio: vi.fn(),
    applyAnswer: vi.fn(async () => {}),
    close: vi.fn(),
    createOffer: vi.fn(async () => "offer-sdp"),
    sendAudio: vi.fn(),
  } satisfies RealtimeWebRtcAudioPeerContract;
}

describe("Codex app-server realtime voice transport", () => {
  it("starts V3 without overriding the model and recovers a known reset after its old close", async () => {
    const request = createRequest();
    const clientRequest = vi.fn(async (_method: string, _params?: unknown) => undefined);
    const firstPeer = createPeer();
    const secondPeer = createPeer();
    const peers = [firstPeer, secondPeer];
    const callbacks: RealtimeWebRtcAudioPeerCallbacks[] = [];
    const createPeerFactory = vi.fn(
      async (
        nextCallbacks: RealtimeWebRtcAudioPeerCallbacks,
      ): Promise<RealtimeWebRtcAudioPeerContract> => {
        callbacks.push(nextCallbacks);
        return peers[callbacks.length - 1]!;
      },
    );
    const bridge = createCodexAppServerRealtimeVoiceBridge(
      { request: clientRequest } as unknown as CodexAppServerClient,
      "thread-1",
      request,
      new AbortController().signal,
      createPeerFactory,
    );

    const initialConnect = bridge.connect();
    await vi.waitFor(() => expect(clientRequest).toHaveBeenCalledTimes(1));
    expect(clientRequest.mock.calls[0]?.[0]).toBe("thread/realtime/start");
    expect(clientRequest.mock.calls[0]?.[1]).toMatchObject({
      threadId: "thread-1",
      version: "v3",
      includeStartupContext: true,
      initialItems: [{ role: "developer", text: "Use the bound OpenClaw agent." }],
      voice: "arbor",
      transport: { type: "webrtc", sdp: "offer-sdp" },
    });
    expect(clientRequest.mock.calls[0]?.[1]).not.toHaveProperty("model");
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "answer-1" },
    });
    await initialConnect;

    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "user", text: "Remember cobalt." },
    });
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "Remembered." },
    });

    bridge.handleNotification({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: RESET_ERROR },
    });
    expect(firstPeer.close).toHaveBeenCalledOnce();
    expect(request.onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.continuity.reset",
      detail: "codex-transport-recovery",
    });
    expect(clientRequest).toHaveBeenCalledTimes(1);
    expect(request.onError).not.toHaveBeenCalled();
    expect(request.onClose).not.toHaveBeenCalled();
    bridge.sendAudio(Buffer.from("recovering-input"));
    expect(firstPeer.sendAudio).not.toHaveBeenCalled();

    bridge.handleNotification({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "error" },
    });
    await vi.waitFor(() => expect(clientRequest).toHaveBeenCalledTimes(2));
    expect(clientRequest.mock.calls[1]?.[1]).toMatchObject({
      initialItems: [
        { role: "developer", text: "Use the bound OpenClaw agent." },
        { role: "user", text: "Remember cobalt." },
        { role: "assistant", text: "Remembered." },
      ],
    });
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "answer-2" },
    });
    await vi.waitFor(() => expect(request.onReady).toHaveBeenCalledTimes(2));
    expect(secondPeer.sendAudio).toHaveBeenCalledWith(Buffer.from("recovering-input"));

    callbacks[0]?.onAudio(Buffer.from("stale"));
    callbacks[0]?.onError(new Error("stale peer"));
    callbacks[1]?.onAudio(Buffer.from("fresh"));
    bridge.sendAudio(Buffer.from("input"));
    expect(request.onAudio).toHaveBeenCalledOnce();
    expect(request.onAudio).toHaveBeenCalledWith(Buffer.from("fresh"));
    expect(firstPeer.sendAudio).not.toHaveBeenCalled();
    expect(secondPeer.sendAudio.mock.calls).toEqual([
      [Buffer.from("recovering-input")],
      [Buffer.from("input")],
    ]);
    expect(request.onError).not.toHaveBeenCalled();
  });

  it("treats unrelated realtime errors as terminal", async () => {
    const request = createRequest();
    const peer = createPeer();
    const clientRequest = vi.fn(async (_method: string, _params?: unknown) => undefined);
    const bridge = createCodexAppServerRealtimeVoiceBridge(
      { request: clientRequest } as unknown as CodexAppServerClient,
      "thread-1",
      request,
      new AbortController().signal,
      async () => peer,
    );
    const connecting = bridge.connect();
    await vi.waitFor(() => expect(clientRequest).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "answer" },
    });
    await connecting;

    bridge.handleNotification({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: "authentication failed" },
    });
    await vi.waitFor(() => expect(request.onClose).toHaveBeenCalledWith("error"));
    expect(request.onError).toHaveBeenCalledWith(new Error("authentication failed"));
  });

  it("replays a user transcript that was interrupted before its assistant response", async () => {
    const request = createRequest();
    const firstPeer = createPeer();
    const secondPeer = createPeer();
    const peers = [firstPeer, secondPeer];
    const clientRequest = vi.fn(async (_method: string, _params?: unknown) => undefined);
    const bridge = createCodexAppServerRealtimeVoiceBridge(
      { request: clientRequest } as unknown as CodexAppServerClient,
      "thread-1",
      request,
      new AbortController().signal,
      async () => peers.shift()!,
    );
    const initialConnect = bridge.connect();
    await vi.waitFor(() => expect(clientRequest).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "answer-1" },
    });
    await initialConnect;
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "user", text: "Finish this request." },
    });

    bridge.handleNotification({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: RESET_ERROR },
    });
    bridge.handleNotification({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "error" },
    });
    await vi.waitFor(() => expect(clientRequest).toHaveBeenCalledTimes(2));
    expect(clientRequest.mock.calls[1]?.[1]).toMatchObject({
      initialItems: [{ role: "developer", text: "Use the bound OpenClaw agent." }],
    });
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "answer-2" },
    });
    await vi.waitFor(() => expect(clientRequest).toHaveBeenCalledTimes(3));
    expect(clientRequest.mock.calls[2]).toEqual([
      "thread/realtime/appendText",
      { threadId: "thread-1", role: "user", text: "Finish this request." },
      { signal: expect.any(AbortSignal) },
    ]);
    await vi.waitFor(() => expect(request.onReady).toHaveBeenCalledTimes(2));

    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "user", text: "Finish this request." },
    });
    expect(request.onTranscript).toHaveBeenCalledTimes(1);
  });
});
