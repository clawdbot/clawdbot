import { expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { defaultTabs, FakeSocket, flush, sendHello } from "./relay-bridge.test-support.js";

it.each(["attach", "createTab"])(
  "does not acknowledge close before a pending %s and its native detach finish",
  async (operation) => {
    const bridge = new ExtensionRelayBridge();
    const extensionSocket = new FakeSocket();
    const extension = bridge.attachExtensionSocket(extensionSocket);
    sendHello(extension, operation === "attach" ? defaultTabs() : []);
    const clientSocket = new FakeSocket();
    const client = bridge.attachCdpClientSocket(clientSocket);
    try {
      client.onMessage(
        JSON.stringify({
          id: 1,
          method: operation === "attach" ? "Target.setAutoAttach" : "Target.createTarget",
          params: operation === "attach" ? { autoAttach: true } : { url: "about:blank" },
        }),
      );
      const command = extensionSocket.frames().find((frame) => frame.type === operation);
      expect(command).toBeDefined();
      let finished = false;
      const closing = client.onClose().then(() => {
        finished = true;
      });
      await flush();
      expect(finished).toBe(false);
      extension.onMessage(
        JSON.stringify({
          type: "result",
          seq: command?.seq,
          result: { tabId: 1, targetId: "target-1" },
        }),
      );
      await vi.waitFor(() =>
        expect(extensionSocket.frames().some((frame) => frame.type === "detach")).toBe(true),
      );
      expect(finished).toBe(false);
      const detach = extensionSocket.frames().find((frame) => frame.type === "detach");
      extension.onMessage(JSON.stringify({ type: "result", seq: detach?.seq, result: {} }));
      await closing;
      expect(finished).toBe(true);
      expect(clientSocket.frames()).toEqual([]);
    } finally {
      bridge.dispose();
    }
  },
);
