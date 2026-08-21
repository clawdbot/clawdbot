import { describe, expect, it, vi } from "vitest";
import { createNodeDuplexEndpoint } from "./node-duplex-framing.js";

const FRAGMENT_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;

function dataFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    kind: "data",
    message: 0,
    index: 0,
    last: true,
    data: Buffer.from("message").toString("base64"),
    ...overrides,
  });
}

describe("node duplex message framing", () => {
  it("transfers binary messages larger than transport frames in both directions", async () => {
    const outboundFrames: string[] = [];
    const inboundFrames: string[] = [];
    const leftMessages: Uint8Array[] = [];
    const rightMessages: Uint8Array[] = [];
    const left = createNodeDuplexEndpoint({
      sendFrame(frame) {
        outboundFrames.push(frame);
        right.receive(frame);
      },
    });
    const right = createNodeDuplexEndpoint({
      sendFrame(frame) {
        inboundFrames.push(frame);
        left.receive(frame);
      },
    });
    left.onMessage((message) => {
      leftMessages.push(message);
    });
    right.onMessage((message) => {
      rightMessages.push(message);
    });

    const outbound = Uint8Array.from({ length: 40_000 }, (_, index) => index % 251);
    const inbound = Uint8Array.from({ length: 25_000 }, (_, index) => 255 - (index % 251));
    await left.send(outbound);
    await right.send(inbound);

    expect(rightMessages).toEqual([outbound]);
    expect(leftMessages).toEqual([inbound]);
    expect(outboundFrames.length).toBeGreaterThan(2);
    expect(inboundFrames.length).toBeGreaterThan(2);
    expect([...outboundFrames, ...inboundFrames]).toSatisfy((frames: string[]) =>
      frames.every((frame) => Buffer.byteLength(frame, "utf8") < 16 * 1024),
    );
  });

  it("preserves complete message boundaries across concurrent asynchronous sends", async () => {
    const received: Uint8Array[] = [];
    const first = Uint8Array.from({ length: 20_000 }, () => 1);
    const second = Uint8Array.from({ length: 18_000 }, () => 2);
    const receiver = createNodeDuplexEndpoint({ sendFrame: () => {} });
    receiver.onMessage((message) => {
      received.push(message);
    });
    const sender = createNodeDuplexEndpoint({
      async sendFrame(frame) {
        await Promise.resolve();
        receiver.receive(frame);
      },
    });

    await Promise.all([sender.send(first), sender.send(second)]);

    expect(received).toEqual([first, second]);
  });

  it("serializes framed readiness ahead of a concurrent message", async () => {
    const events: string[] = [];
    const receiver = createNodeDuplexEndpoint({
      sendFrame: () => {},
      onReady: () => events.push("ready"),
    });
    receiver.onMessage(() => {
      events.push("message");
    });
    const sender = createNodeDuplexEndpoint({
      async sendFrame(frame) {
        await Promise.resolve();
        receiver.receive(frame);
      },
    });

    await Promise.all([sender.sendReady(), sender.send(Uint8Array.of(1, 2))]);

    expect(events).toEqual(["ready", "message"]);
  });

  it("rejects data before required readiness while node-host input needs no reciprocal ready", () => {
    const gatewayError = vi.fn();
    const gateway = createNodeDuplexEndpoint({
      sendFrame: () => {},
      onError: gatewayError,
      requireReady: true,
    });

    expect(() => gateway.receive(dataFrame())).toThrow(/before framed readiness/i);
    expect(gatewayError).toHaveBeenCalledOnce();

    const hostMessage = vi.fn();
    const host = createNodeDuplexEndpoint({ sendFrame: () => {} });
    host.onMessage(hostMessage);
    host.receive(dataFrame());
    expect(hostMessage).toHaveBeenCalledOnce();
  });

  it("preserves empty binary messages as distinct complete messages", async () => {
    const received: Uint8Array[] = [];
    const receiver = createNodeDuplexEndpoint({ sendFrame: () => {} });
    receiver.onMessage((message) => {
      received.push(message);
    });
    const sender = createNodeDuplexEndpoint({ sendFrame: (frame) => receiver.receive(frame) });

    await sender.send(new Uint8Array());
    await sender.send(Uint8Array.of(7));

    expect(received).toEqual([new Uint8Array(), Uint8Array.of(7)]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong version", dataFrame({ v: 2 })],
    ["unknown kind", dataFrame({ kind: "unknown" })],
    ["extra field", dataFrame({ extra: true })],
    ["noncanonical base64", dataFrame({ data: "bWVzc2FnZQ" })],
    ["invalid base64", dataFrame({ data: "%%%%" })],
    ["negative message id", dataFrame({ message: -1 })],
    ["unsafe message id", dataFrame({ message: Number.MAX_SAFE_INTEGER + 1 })],
    ["message gap", dataFrame({ message: 1 })],
    ["fragment gap", dataFrame({ index: 1 })],
    ["negative fragment index", dataFrame({ index: -1 })],
    ["unsafe fragment index", dataFrame({ index: Number.MAX_SAFE_INTEGER + 1 })],
    ["undersized nonterminal fragment", dataFrame({ last: false })],
    ["mixed ready fields", JSON.stringify({ v: 1, kind: "ready", data: "" })],
    [
      "oversized fragment",
      dataFrame({ data: Buffer.alloc(FRAGMENT_BYTES + 1).toString("base64") }),
    ],
    ["oversized wire frame", `{"data":"${"a".repeat(16 * 1024)}"}`],
  ])("fails closed on %s", (_reason, frame) => {
    const onError = vi.fn();
    const received = vi.fn();
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {}, onError });
    endpoint.onMessage(received);

    expect(() => endpoint.receive(frame)).toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(() => endpoint.receive(dataFrame())).toThrow(/closed/i);
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "duplicate fragment",
      [
        dataFrame({
          last: false,
          data: Buffer.alloc(FRAGMENT_BYTES).toString("base64"),
        }),
        dataFrame({ index: 0 }),
      ],
    ],
    [
      "fragment gap",
      [
        dataFrame({
          last: false,
          data: Buffer.alloc(FRAGMENT_BYTES).toString("base64"),
        }),
        dataFrame({ index: 2 }),
      ],
    ],
    [
      "interleaved message",
      [
        dataFrame({
          last: false,
          data: Buffer.alloc(FRAGMENT_BYTES).toString("base64"),
        }),
        dataFrame({ message: 1, index: 1 }),
      ],
    ],
    ["duplicate completed message", [dataFrame(), dataFrame()]],
    [
      "duplicate readiness",
      [JSON.stringify({ v: 1, kind: "ready" }), JSON.stringify({ v: 1, kind: "ready" })],
    ],
    ["late readiness", [dataFrame(), JSON.stringify({ v: 1, kind: "ready" })]],
  ])("rejects %s without delivering subsequent messages", (_reason, frames) => {
    const onError = vi.fn();
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {}, onError });
    endpoint.onMessage(() => {});
    endpoint.receive(frames[0]!);

    expect(() => endpoint.receive(frames[1]!)).toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("bounds pending message count and bytes before a listener subscribes", async () => {
    const countError = vi.fn();
    const countBounded = createNodeDuplexEndpoint({ sendFrame: () => {}, onError: countError });
    for (let message = 0; message < 8; message += 1) {
      countBounded.receive(dataFrame({ message }));
    }
    expect(() => countBounded.receive(dataFrame({ message: 8 }))).toThrow(/pending/i);
    expect(countError).toHaveBeenCalledOnce();

    const bytesError = vi.fn();
    const bytesBounded = createNodeDuplexEndpoint({ sendFrame: () => {}, onError: bytesError });
    const sender = createNodeDuplexEndpoint({
      sendFrame: (frame) => bytesBounded.receive(frame),
    });
    await sender.send(new Uint8Array(600_000));
    await expect(sender.send(new Uint8Array(600_000))).rejects.toThrow(/pending/i);
    expect(bytesError).toHaveBeenCalledOnce();
  });

  it("bounds incomplete fragments against bytes already buffered before listener registration", () => {
    const onError = vi.fn();
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {}, onError });
    endpoint.receive(dataFrame({ data: "eA==" }));
    const fragment = Buffer.alloc(FRAGMENT_BYTES).toString("base64");
    for (let index = 0; index < 127; index += 1) {
      endpoint.receive(dataFrame({ message: 1, index, last: false, data: fragment }));
    }

    expect(() =>
      endpoint.receive(dataFrame({ message: 1, index: 127, last: false, data: fragment })),
    ).toThrow(/pending/i);
    expect(onError).toHaveBeenCalledOnce();
    expect(() => endpoint.receive(dataFrame({ message: 1, index: 128 }))).toThrow(/closed/i);
  });

  it("accepts logical messages above the pending-byte limit after listener registration", async () => {
    const received = vi.fn();
    const receiver = createNodeDuplexEndpoint({ sendFrame: () => {} });
    receiver.onMessage(received);
    const sender = createNodeDuplexEndpoint({ sendFrame: (frame) => receiver.receive(frame) });
    const message = new Uint8Array(1024 * 1024 + 1);

    await sender.send(message);

    expect(received).toHaveBeenCalledExactlyOnceWith(message);
  });

  it("delivers buffered whole messages in order when the listener subscribes", () => {
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {} });
    endpoint.receive(dataFrame());
    endpoint.receive(dataFrame({ message: 1, data: Buffer.from("second").toString("base64") }));
    const received: string[] = [];

    endpoint.onMessage((message) => {
      received.push(Buffer.from(message).toString());
    });

    expect(received).toEqual(["message", "second"]);
  });

  it("rejects oversized outbound and inbound logical messages", async () => {
    const sendFrame = vi.fn();
    const outboundError = vi.fn();
    const sender = createNodeDuplexEndpoint({
      sendFrame,
      onError: outboundError,
      maxMessageBytes: 5,
    });

    await expect(sender.send(Uint8Array.of(1, 2, 3, 4, 5, 6))).rejects.toThrow(/maximum/i);
    expect(sendFrame).not.toHaveBeenCalled();
    expect(outboundError).toHaveBeenCalledOnce();

    const inboundError = vi.fn();
    const receiver = createNodeDuplexEndpoint({
      sendFrame: () => {},
      onError: inboundError,
      maxMessageBytes: 5,
    });
    expect(() => receiver.receive(dataFrame())).toThrow(/maximum/i);
    expect(inboundError).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_MESSAGE_BYTES + 1])(
    "rejects an unsafe logical message limit of %s bytes",
    (maxMessageBytes) => {
      expect(() => createNodeDuplexEndpoint({ sendFrame: () => {}, maxMessageBytes })).toThrow(
        /maximum/i,
      );
    },
  );

  it("rejects accumulated message overflow and excessive fragment counts", () => {
    const fragment = Buffer.alloc(FRAGMENT_BYTES).toString("base64");
    const overflow = createNodeDuplexEndpoint({
      sendFrame: () => {},
      maxMessageBytes: FRAGMENT_BYTES + 1,
    });
    overflow.receive(dataFrame({ last: false, data: fragment }));
    expect(() =>
      overflow.receive(dataFrame({ index: 1, data: Buffer.from("xx").toString("base64") })),
    ).toThrow(/maximum/i);

    const excessive = createNodeDuplexEndpoint({
      sendFrame: () => {},
      maxMessageBytes: FRAGMENT_BYTES,
    });
    excessive.receive(dataFrame({ last: false, data: fragment }));
    expect(() => excessive.receive(dataFrame({ index: 1, data: "" }))).toThrow(/fragment/i);
  });

  it("ignores empty heartbeat frames without disturbing message ordering", () => {
    const received = vi.fn();
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {} });
    endpoint.onMessage(received);

    endpoint.receive("");
    endpoint.receive(dataFrame());
    endpoint.receive("");
    endpoint.receive(dataFrame({ message: 1 }));

    expect(received).toHaveBeenCalledTimes(2);
  });

  it("closes when a message listener throws and never invokes it afterward", () => {
    const failure = new Error("listener exploded");
    const onError = vi.fn();
    const listener = vi.fn(() => {
      throw failure;
    });
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {}, onError });
    endpoint.onMessage(listener);

    expect(() => endpoint.receive(dataFrame())).toThrow(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(() => endpoint.receive(dataFrame({ message: 1 }))).toThrow(/closed/i);
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each(["immediate", "buffered"] as const)(
    "closes after an asynchronous %s message listener rejects",
    async (delivery) => {
      const failure = new Error("asynchronous listener exploded");
      const onError = vi.fn();
      const listener = vi.fn(() => {
        const rejection = Promise.reject(failure);
        void rejection.catch(() => {});
        return rejection;
      });
      const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {}, onError });
      if (delivery === "buffered") {
        endpoint.receive(dataFrame());
      }
      endpoint.onMessage(listener);
      if (delivery === "immediate") {
        endpoint.receive(dataFrame());
      }

      await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure));
      expect(() => endpoint.receive(dataFrame({ message: 1 }))).toThrow(/closed/i);
      expect(listener).toHaveBeenCalledOnce();
    },
  );

  it("bounds outstanding asynchronous listener deliveries before invoking another callback", () => {
    const onError = vi.fn();
    const neverSettles = new Promise<void>(() => {});
    const listener = vi.fn(() => neverSettles);
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {}, onError });
    endpoint.onMessage(listener);
    for (let message = 0; message < 8; message += 1) {
      endpoint.receive(dataFrame({ message }));
    }

    expect(() => endpoint.receive(dataFrame({ message: 8 }))).toThrow(/pending|in.flight/i);
    expect(listener).toHaveBeenCalledTimes(8);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("bounds combined bytes held by outstanding asynchronous listener deliveries", () => {
    const onError = vi.fn();
    const listener = vi.fn(() => new Promise<void>(() => {}));
    const endpoint = createNodeDuplexEndpoint({
      sendFrame: () => {},
      onError,
      maxMessageBytes: 16,
    });
    endpoint.onMessage(listener);
    endpoint.receive(dataFrame({ data: Buffer.alloc(10).toString("base64") }));

    expect(() =>
      endpoint.receive(dataFrame({ message: 1, data: Buffer.alloc(7).toString("base64") })),
    ).toThrow(/pending|in.flight/i);
    expect(listener).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each(["immediate", "buffered"] as const)(
    "drains an asynchronous %s listener before allowing invocation completion",
    async (delivery) => {
      let finishListener: (() => void) | undefined;
      const listenerFinished = new Promise<void>((resolve) => {
        finishListener = resolve;
      });
      const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {} });
      if (delivery === "buffered") {
        endpoint.receive(dataFrame());
      }
      endpoint.onMessage(() => listenerFinished);
      if (delivery === "immediate") {
        endpoint.receive(dataFrame());
      }
      let drained = false;
      const drain = endpoint.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      finishListener?.();
      await drain;

      expect(drained).toBe(true);
    },
  );

  it("continues draining listener work that arrives while an earlier delivery is pending", async () => {
    const finishListeners: Array<() => void> = [];
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {} });
    endpoint.onMessage(
      () =>
        new Promise<void>((resolve) => {
          finishListeners.push(resolve);
        }),
    );
    endpoint.receive(dataFrame());
    let drained = false;
    const drain = endpoint.drain().then(() => {
      drained = true;
    });
    endpoint.receive(dataFrame({ message: 1 }));

    finishListeners[0]?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(drained).toBe(false);

    finishListeners[1]?.();
    await drain;
    expect(drained).toBe(true);
  });

  it("preserves the original asynchronous listener failure while draining", async () => {
    let rejectListener: ((error: Error) => void) | undefined;
    const listenerFinished = new Promise<void>((_resolve, reject) => {
      rejectListener = reject;
    });
    const failure = new Error("asynchronous drain listener exploded");
    const onError = vi.fn();
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {}, onError });
    endpoint.onMessage(() => listenerFinished);
    endpoint.receive(dataFrame());
    const drain = endpoint.drain();

    rejectListener?.(failure);

    await expect(drain).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("rejects drain immediately when closing with a listener that never settles", async () => {
    const listenerFinished = new Promise<void>(() => {});
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {} });
    endpoint.onMessage(() => listenerFinished);
    endpoint.receive(dataFrame());
    const drain = endpoint.drain();

    endpoint.close();

    await expect(drain).rejects.toThrow(/closed/i);
  });

  it("closes and reports asynchronous frame transport failure exactly once", async () => {
    const failure = new Error("node transport disconnected");
    const onError = vi.fn();
    const endpoint = createNodeDuplexEndpoint({
      async sendFrame() {
        throw failure;
      },
      onError,
    });

    await expect(endpoint.send(Uint8Array.of(1))).rejects.toThrow(failure);
    await expect(endpoint.send(Uint8Array.of(2))).rejects.toThrow(/closed/i);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each(["message", "ready"] as const)(
    "rejects %s when the endpoint closes during its final transport await",
    async (operation) => {
      let releaseTransport: (() => void) | undefined;
      const transportReleased = new Promise<void>((resolve) => {
        releaseTransport = resolve;
      });
      const endpoint = createNodeDuplexEndpoint({
        async sendFrame() {
          await transportReleased;
        },
      });
      const pending =
        operation === "message" ? endpoint.send(Uint8Array.of(1)) : endpoint.sendReady();
      await Promise.resolve();

      endpoint.close();
      releaseTransport?.();

      await expect(pending).rejects.toThrow(/closed/i);
    },
  );

  it("closes when the framed-ready callback rejects unexpected readiness", () => {
    const failure = new Error("node readiness preceded dispatch");
    const onError = vi.fn();
    const endpoint = createNodeDuplexEndpoint({
      sendFrame: () => {},
      onReady() {
        throw failure;
      },
      onError,
    });

    expect(() => endpoint.receive(JSON.stringify({ v: 1, kind: "ready" }))).toThrow(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("rejects a second active listener and subscriptions after closure", () => {
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {} });
    const unsubscribe = endpoint.onMessage(() => {});

    expect(() => endpoint.onMessage(() => {})).toThrow(/listener/i);
    unsubscribe();
    endpoint.onMessage(() => {});
    endpoint.close();
    expect(() => endpoint.onMessage(() => {})).toThrow(/closed/i);
  });

  it("rejects retained send and incoming data after an idempotent close", async () => {
    const listener = vi.fn();
    const endpoint = createNodeDuplexEndpoint({ sendFrame: () => {} });
    endpoint.onMessage(listener);

    endpoint.close();
    endpoint.close();

    await expect(endpoint.send(Uint8Array.of(1))).rejects.toThrow(/closed/i);
    expect(() => endpoint.receive(dataFrame())).toThrow(/closed/i);
    expect(listener).not.toHaveBeenCalled();
  });
});
