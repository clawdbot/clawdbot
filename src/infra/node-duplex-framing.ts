import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";

const NODE_DUPLEX_FRAGMENT_BYTES = 8 * 1024;
const NODE_DUPLEX_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;

const MAX_PENDING_MESSAGES = 8;
const MAX_PENDING_BYTES = 1024 * 1024;

/** Owns ordered, bounded binary messages carried by existing node-invoke string frames. */
export function createNodeDuplexEndpoint(options: {
  sendFrame: (frame: string) => Promise<void> | void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  requireReady?: boolean;
  maxMessageBytes?: number;
}) {
  const maxMessageBytes = options.maxMessageBytes ?? NODE_DUPLEX_MAX_MESSAGE_BYTES;
  const invalidMessageLimit = !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1;
  if (invalidMessageLimit || maxMessageBytes > NODE_DUPLEX_MAX_MESSAGE_BYTES) {
    throw new Error("node duplex maximum message bytes must be between 1 and 100 MiB");
  }
  let closed = false;
  const ready = { sent: false, received: false };
  let nextOutgoingMessage = 0;
  const incoming = { message: 0, fragment: 0 };
  let activeDeliveryBytes = 0;
  let listener: ((message: Uint8Array) => void | Promise<void>) | undefined;
  let sendQueue = Promise.resolve();
  const drainClosed = createDeferredCore();
  void drainClosed.promise.catch(() => {});
  const incomingFragments: Uint8Array[] = [];
  const pendingMessages: Uint8Array[] = [];
  const activeDeliveries = new Set<Promise<void>>();

  const assertOpen = () => {
    if (closed) {
      throw new Error("node duplex channel is closed");
    }
  };

  const close = (reason = new Error("node duplex channel is closed")) => {
    closed = true;
    drainClosed.reject(reason);
    listener = undefined;
    incomingFragments.length = 0;
    pendingMessages.length = 0;
    activeDeliveries.clear();
  };

  const fail = (cause: unknown): Error => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!closed) {
      close(error);
      options.onError?.(error);
    }
    return error;
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const operation = sendQueue.then(task);
    // Keep rejected sends observed without allowing concurrent messages to interleave.
    sendQueue = operation.catch(() => {});
    return operation.catch((error: unknown) => {
      throw fail(error);
    });
  };

  const observeListener = (callback: NonNullable<typeof listener>, message: Uint8Array) => {
    const bytesExceeded = activeDeliveryBytes + message.byteLength > maxMessageBytes;
    if (activeDeliveries.size >= MAX_PENDING_MESSAGES || bytesExceeded) {
      throw new Error("node duplex pending listener delivery exceeded its bounded capacity");
    }
    const result = callback(message);
    if (!result) {
      return;
    }
    activeDeliveryBytes += message.byteLength;
    const delivery = Promise.resolve(result).finally(() => {
      activeDeliveries.delete(delivery);
      activeDeliveryBytes -= message.byteLength;
    });
    activeDeliveries.add(delivery);
    void delivery.catch(fail);
  };

  const acceptData = (frame: Record<string, unknown>) => {
    if (
      Object.keys(frame).length !== 6 ||
      !Number.isSafeInteger(frame.message) ||
      !Number.isSafeInteger(frame.index) ||
      typeof frame.last !== "boolean" ||
      typeof frame.data !== "string"
    ) {
      throw new Error("node duplex data frame has an invalid closed shape");
    }
    if (frame.message !== incoming.message || frame.index !== incoming.fragment) {
      throw new Error("node duplex message or fragment arrived out of order");
    }
    const fragment = Buffer.from(frame.data, "base64");
    if (
      fragment.toString("base64") !== frame.data ||
      fragment.byteLength > NODE_DUPLEX_FRAGMENT_BYTES ||
      (!frame.last && fragment.byteLength !== NODE_DUPLEX_FRAGMENT_BYTES) ||
      (frame.last && fragment.byteLength === 0 && incoming.fragment > 0)
    ) {
      throw new Error("node duplex fragment has invalid canonical base64 or bounded size");
    }
    const incomingBytes = incoming.fragment * NODE_DUPLEX_FRAGMENT_BYTES;
    if (incomingBytes + fragment.byteLength > maxMessageBytes) {
      throw new Error("node duplex logical message exceeds its maximum size");
    }
    const pendingBytes = pendingMessages.reduce((total, message) => total + message.byteLength, 0);
    if (!listener && pendingBytes + incomingBytes + fragment.byteLength > MAX_PENDING_BYTES) {
      throw new Error("node duplex pending message buffer exceeded its bounded capacity");
    }
    incomingFragments.push(fragment);
    incoming.fragment += 1;
    if (!frame.last) {
      return;
    }
    const assembled = Buffer.concat(incomingFragments, incomingBytes + fragment.byteLength);
    const message = new Uint8Array(assembled.buffer, assembled.byteOffset, assembled.byteLength);
    incomingFragments.length = 0;
    incoming.fragment = 0;
    incoming.message += 1;
    if (listener) {
      observeListener(listener, message);
      return;
    }
    if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
      throw new Error("node duplex pending message buffer exceeded its bounded capacity");
    }
    pendingMessages.push(message);
  };

  return {
    send(message: Uint8Array): Promise<void> {
      return enqueue(async () => {
        if (!(message instanceof Uint8Array) || message.byteLength > maxMessageBytes) {
          throw new Error("node duplex logical message exceeds its maximum size");
        }
        if (!Number.isSafeInteger(nextOutgoingMessage)) {
          throw new Error("node duplex message sequence exceeded its maximum");
        }
        const messageId = nextOutgoingMessage++;
        const fragments = Math.max(1, Math.ceil(message.byteLength / NODE_DUPLEX_FRAGMENT_BYTES));
        for (let index = 0; index < fragments; index += 1) {
          assertOpen();
          const start = index * NODE_DUPLEX_FRAGMENT_BYTES;
          const fragment = message.subarray(start, start + NODE_DUPLEX_FRAGMENT_BYTES);
          await options.sendFrame(
            JSON.stringify({
              v: 1,
              kind: "data",
              message: messageId,
              index,
              last: index === fragments - 1,
              data: Buffer.from(fragment).toString("base64"),
            }),
          );
          assertOpen();
        }
      });
    },

    sendReady(): Promise<void> {
      return enqueue(async () => {
        assertOpen();
        if (ready.sent || nextOutgoingMessage > 0) {
          throw new Error("node duplex framed readiness is duplicate or out of order");
        }
        ready.sent = true;
        await options.sendFrame(JSON.stringify({ v: 1, kind: "ready" }));
        assertOpen();
      });
    },

    receive(frame: string): void {
      if (!frame) {
        return;
      }
      assertOpen();
      try {
        if (Buffer.byteLength(frame, "utf8") > 16 * 1024) {
          throw new Error("node duplex wire frame exceeds the 16 KiB transport limit");
        }
        const parsed: unknown = JSON.parse(frame);
        if (!isRecord(parsed) || parsed.v !== 1) {
          throw new Error("node duplex frame has an unsupported version or shape");
        }
        if (parsed.kind === "ready") {
          const receivedData = incoming.message > 0 || incoming.fragment > 0;
          if (Object.keys(parsed).length !== 2 || ready.received || receivedData) {
            throw new Error("node duplex framed readiness is malformed, duplicate, or late");
          }
          ready.received = true;
          options.onReady?.();
          return;
        }
        if (parsed.kind !== "data" || (options.requireReady && !ready.received)) {
          throw new Error(
            "node duplex frame has unsupported kind or arrived before framed readiness",
          );
        }
        acceptData(parsed);
      } catch (error) {
        throw fail(error);
      }
    },

    onMessage(callback: (message: Uint8Array) => void | Promise<void>): () => void {
      assertOpen();
      if (listener) {
        throw new Error("node duplex channel already has an active message listener");
      }
      listener = callback;
      try {
        while (pendingMessages.length > 0) {
          const message = pendingMessages.shift()!;
          observeListener(callback, message);
        }
      } catch (error) {
        throw fail(error);
      }
      return () => {
        if (listener === callback) {
          listener = undefined;
        }
      };
    },

    close,
    drain: async () => {
      assertOpen();
      while (activeDeliveries.size > 0) {
        await Promise.race([drainClosed.promise, Promise.all(activeDeliveries)]);
      }
    },
  };
}
