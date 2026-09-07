import { describe, expect, it, vi } from "vitest";
import { BrowserScreencastClient } from "./browser-screencast-client.ts";
import { screencastFrame, TestScreencastSocket } from "./browser-screencast-test-support.ts";

function connect() {
  const socket = new TestScreencastSocket("");
  const createSocket = vi.fn(() => socket as unknown as WebSocket);
  const callbacks = { onReady: vi.fn(), onMeta: vi.fn(), onFrame: vi.fn(), onClose: vi.fn() };
  const client = new BrowserScreencastClient(
    {
      gatewayUrl: "https://gateway.example.test/chat",
      wsPath: "/browser/screencast?token=abc",
      ...callbacks,
    },
    createSocket,
  );
  return { socket, createSocket, callbacks, client };
}

describe("BrowserScreencastClient", () => {
  it("resolves the gateway socket and decodes metadata and JPEG bytes", async () => {
    const { socket, createSocket, callbacks, client } = connect();
    expect(createSocket).toHaveBeenCalledWith(
      "wss://gateway.example.test/browser/screencast?token=abc",
    );
    expect(socket.binaryType).toBe("arraybuffer");
    socket.receive(
      JSON.stringify({
        type: "ready",
        targetId: "raw-tab",
        url: "https://example.test/page",
        title: "Page",
      }),
    );
    socket.receive(
      JSON.stringify({ type: "meta", url: "https://example.test/next", title: "Next" }),
    );
    socket.receive(screencastFrame());
    expect(callbacks.onReady).toHaveBeenCalledWith({
      targetId: "raw-tab",
      url: "https://example.test/page",
      title: "Page",
    });
    expect(callbacks.onMeta).toHaveBeenCalledWith({
      url: "https://example.test/next",
      title: "Next",
    });
    const [frame] = callbacks.onFrame.mock.calls[0]!;
    expect(frame).toMatchObject({
      url: "https://example.test/page",
      cssWidth: 100,
      cssHeight: 100,
    });
    expect(frame.blob.type).toBe("image/jpeg");
    expect(new Uint8Array(await frame.blob.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
    client.close();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it.each([
    [4003, "navigation_blocked"],
    [4004, "target_closed"],
    [1012, "gateway shutting down"],
  ])("preserves close code %i and reason", (code, reason) => {
    const { socket, callbacks } = connect();
    socket.disconnect(code, reason);
    socket.receive(screencastFrame());
    expect(callbacks.onClose).toHaveBeenCalledExactlyOnceWith({ code, reason });
    expect(callbacks.onFrame).not.toHaveBeenCalled();
  });

  it.each(["{", new ArrayBuffer(2), new Uint8Array([0, 0, 1, 0, 0]).buffer])(
    "closes malformed input without forwarding a frame",
    (wire) => {
      const { socket, callbacks } = connect();
      socket.receive(wire);
      expect(callbacks.onClose).toHaveBeenCalledExactlyOnceWith({ code: 1002, reason: "" });
      expect(socket.close).toHaveBeenCalledOnce();
      expect(callbacks.onFrame).not.toHaveBeenCalled();
    },
  );

  it("maps errors to a terminal failure and suppresses intentional-close callbacks", () => {
    const failed = connect();
    failed.socket.receive(JSON.stringify({ type: "error", error: "Unavailable" }));
    failed.socket.disconnect(1011);
    expect(failed.callbacks.onClose).toHaveBeenCalledExactlyOnceWith({ code: 1011, reason: "" });
    const closed = connect();
    closed.client.close();
    closed.socket.disconnect(1000);
    expect(closed.callbacks.onClose).not.toHaveBeenCalled();
  });
});
