import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { relayOwnerReply, relayOwnerRetired } from "./owner-protocol.js";
import { attachRelayOwner } from "./owner-server.js";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { EXTENSION_RELAY_MAX_PAYLOAD_BYTES } from "./relay-server.js";

type SendCallback = (error?: Error) => void;
type SendOptions = Parameters<WebSocket["send"]>[1];

it.each(["EPIPE", "ECONNRESET"])(
  "keeps completed owner cleanup successful when its retirement notice fails with %s",
  async (code) => {
    const bridge = new ExtensionRelayBridge();
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback listener");
    }
    const accepted = new Promise<WebSocket>((resolve) => {
      server.once("connection", resolve);
    });
    const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
    try {
      await once(peer, "open");
      const socket = await accepted;
      const retire = attachRelayOwner({
        ws: socket,
        bridge,
        allowLegacyAuth: false,
        isCurrent: () => true,
      });
      const opened = once(peer, "message");
      peer.send(JSON.stringify({ id: 1, op: "cdp.open" }));
      const [raw] = await opened;
      expect(relayOwnerReply.parse(JSON.parse(rawDataToString(raw)))).toMatchObject({
        id: 1,
        result: expect.any(Number),
      });
      expect(bridge.cdpClientCount).toBe(1);

      const notice = createDeferred<SendCallback>();
      const send = socket.send.bind(socket);
      vi.spyOn(socket, "send").mockImplementation(
        (data, optionsOrCallback?: SendOptions | SendCallback, callback?: SendCallback) => {
          const completion = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
          if (typeof data === "string" && relayOwnerRetired.safeParse(JSON.parse(data)).success) {
            expect(bridge.cdpClientCount).toBe(0);
            if (!completion) {
              throw new Error("Retirement notice must observe write completion");
            }
            notice.resolve(completion);
            return;
          }
          if (typeof optionsOrCallback === "function") {
            send(data, optionsOrCallback);
          } else {
            send(data, optionsOrCallback ?? {}, callback);
          }
        },
      );
      let retired = false;
      const retiring = retire().then(() => {
        retired = true;
      });
      const completeWrite = await notice.promise;
      expect(retired).toBe(false);
      const completed = expect(retiring).resolves.toBeUndefined();
      completeWrite(Object.assign(new Error(`write ${code}`), { code }));
      await completed;
      expect(retired).toBe(true);
      expect(bridge.cdpClientCount).toBe(0);
    } finally {
      vi.restoreAllMocks();
      bridge.dispose();
      peer.terminate();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  },
);
