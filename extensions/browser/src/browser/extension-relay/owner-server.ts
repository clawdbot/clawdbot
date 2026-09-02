import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { WebSocket } from "ws";
import { randomRelayId } from "./auth-v2-crypto.js";
import { parseStrictJsonObject } from "./auth-v2.js";
import {
  RELAY_OPERATION_TTL_MS,
  RELAY_OWNER_LIMIT,
  relayOwnerFrame,
  relayOwnerRequest,
} from "./owner-protocol.js";
import type { ExtensionRelayBridge } from "./relay-bridge.js";
import { parseExtensionMessage } from "./relay-protocol.js";

/** All references and streams belong to this authenticated connection, never to a token holder. */
export function attachRelayOwner(params: {
  ws: WebSocket;
  bridge: ExtensionRelayBridge;
  allowLegacyAuth: boolean;
  isCurrent: () => boolean;
}): () => Promise<void> {
  const { ws, bridge } = params;
  const controller = new AbortController();
  const captures = new Map<
    string,
    {
      resolve: () => string | undefined;
      isCurrent: () => boolean;
      expires: number;
      timer: NodeJS.Timeout;
    }
  >();
  const streams = new Map<
    number,
    {
      onMessage: (raw: string) => void;
      close: () => Promise<void>;
      ref?: string;
      closing?: Promise<void>;
    }
  >();
  let nextStream = 0;
  let pending = 0;
  let closing: Promise<void> | undefined;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (!params.isCurrent()) {
      throw new Error("Relay owner retired");
    }
  };
  const send = (value: unknown) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(value));
    }
  };
  const captureFor = (ref: string) => {
    assertCurrent();
    const capture = captures.get(ref);
    if (!capture || capture.expires <= Date.now()) {
      captures.delete(ref);
      return undefined;
    }
    return capture.isCurrent() ? capture : undefined;
  };
  const closeStream = async (id: number) => {
    const stream = streams.get(id);
    if (!stream) {
      return;
    }
    // Keep cleanup debt until the real logical/native owner acknowledges it.
    await (stream.closing ??= stream.close());
    if (streams.get(id) === stream) {
      streams.delete(id);
    }
    send({ stream: id, closed: true });
  };
  const close = () => {
    controller.abort(new Error("Relay owner connection closed"));
    for (const capture of captures.values()) {
      clearTimeout(capture.timer);
    }
    captures.clear();
    return (closing ??= Promise.all([...streams.keys()].map(closeStream)).then(() => {}));
  };
  ws.once("close", () => {
    void close().catch(() => {});
  });
  ws.on("message", (raw) => {
    const message = parseStrictJsonObject(rawDataToString(raw));
    const streamFrame = relayOwnerFrame.safeParse(message);
    if (streamFrame.success) {
      const stream = streams.get(streamFrame.data.stream);
      try {
        assertCurrent();
        if (!stream || stream.closing || (stream.ref && !captureFor(stream.ref))) {
          throw new Error("Relay operation reference is no longer current");
        }
        // Command admission runs at the real bridge, immediately before its session fences.
        stream.onMessage(streamFrame.data.frame);
      } catch {
        void closeStream(streamFrame.data.stream).catch(() =>
          ws.close(1011, "relay cleanup failed"),
        );
      }
      return;
    }
    const request = relayOwnerRequest.safeParse(message);
    if (!request.success || pending >= RELAY_OWNER_LIMIT) {
      ws.close(4003, "invalid relay owner request");
      return;
    }
    pending += 1;
    const requestId = request.data.id;
    void (async (): Promise<unknown> => {
      const req = request.data;
      // Revocation stops admission, not acknowledgement of this connection's
      // existing cleanup debt. These operations cannot acquire a grant or stream.
      if (req.op !== "close" && req.op !== "stream.close" && req.op !== "release") {
        assertCurrent();
      }
      switch (req.op) {
        case "ready": {
          await bridge.waitForExtensionConnection(controller.signal, req.timeoutMs);
          assertCurrent();
          return {
            ready: bridge.extensionConnected,
            identity: bridge.identity,
            generation: bridge.extensionGeneration,
            allowLegacyAuth: params.allowLegacyAuth,
          };
        }
        case "capture": {
          const captured = bridge.captureOperationTarget(req.targetId);
          if (!captured) {
            return null;
          }
          if (captures.size >= RELAY_OWNER_LIMIT) {
            throw new Error("Relay operation capacity reached");
          }
          const ref = randomRelayId();
          const timer = setTimeout(() => {
            captures.delete(ref);
            for (const [id, stream] of streams) {
              if (stream.ref === ref) {
                void closeStream(id).catch(() => ws.close(1011, "relay cleanup failed"));
              }
            }
          }, RELAY_OPERATION_TTL_MS);
          timer.unref?.();
          captures.set(ref, {
            resolve: captured,
            isCurrent: captured.isCurrent,
            expires: Date.now() + RELAY_OPERATION_TTL_MS,
            timer,
          });
          return ref;
        }
        case "resolve":
          return captureFor(req.ref)?.resolve() ?? null;
        case "release": {
          const capture = captures.get(req.ref);
          if (capture) {
            clearTimeout(capture.timer);
          }
          captures.delete(req.ref);
          await Promise.all(
            [...streams]
              .filter(([, stream]) => stream.ref === req.ref)
              .map(([id]) => closeStream(id)),
          );
          return null;
        }
        case "cdp.open":
        case "ingress.open": {
          if (streams.size >= RELAY_OWNER_LIMIT) {
            throw new Error("Relay stream capacity reached");
          }
          if (req.op === "cdp.open" && req.ref && !captureFor(req.ref)) {
            throw new Error("Relay operation reference is no longer current");
          }
          const id = ++nextStream;
          const socket = {
            send: (frame: string) => send({ stream: id, frame }),
            close: () => {
              void closeStream(id).catch(() => ws.close(1011, "relay cleanup failed"));
            },
          };
          if (req.op === "cdp.open") {
            const handlers = bridge.attachCdpClientSocket(socket);
            streams.set(id, {
              onMessage: handlers.onMessage,
              close: handlers.onClose,
              ref: req.ref,
            });
          } else {
            const handlers = bridge.attachExtensionSocket(socket);
            const timer = setTimeout(() => socket.close(), 10_000);
            timer.unref?.();
            streams.set(id, {
              onMessage: (frame) => {
                if (parseExtensionMessage(frame)?.type === "hello") {
                  clearTimeout(timer);
                }
                handlers.onMessage(frame);
              },
              close: async () => {
                clearTimeout(timer);
                handlers.onClose();
              },
            });
          }
          return id;
        }
        case "stream.close":
          await closeStream(req.stream);
          return null;
        case "close":
          await close();
          return null;
      }
      throw new Error("Unsupported relay owner operation");
    })()
      .then(
        (result) => send({ id: requestId, result }),
        () => send({ id: requestId, error: "Relay owner operation failed or was superseded" }),
      )
      .finally(() => {
        pending -= 1;
      });
  });
  return async () => {
    await close();
    if (ws.readyState === 1) {
      // Cleanup is acknowledged before this notice. A departing peer may reject
      // its delivery; wait for the write without turning that loss into failed cleanup.
      await new Promise<void>((resolve) => {
        ws.send(JSON.stringify({ retired: true }), () => resolve());
      });
    }
  };
}
