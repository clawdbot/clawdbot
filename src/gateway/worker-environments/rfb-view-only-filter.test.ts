import { describe, expect, it } from "vitest";
import { createRfbClientMessageFilter } from "./rfb-view-only-filter.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");

function noneHandshake(): Buffer {
  return Buffer.concat([VERSION, Buffer.from([1, 1])]);
}

function vncAuthHandshake(): Buffer {
  return Buffer.concat([
    VERSION,
    Buffer.from([2]),
    Buffer.from(Array.from({ length: 16 }, (_, index) => index)),
    Buffer.from([1]),
  ]);
}

function enterMessagePhase() {
  const filter = createRfbClientMessageFilter();
  expect(filter.filter(noneHandshake())).toEqual({ forward: noneHandshake() });
  return filter;
}

describe("RFB view-only client message filter", () => {
  it.each([
    ["None", noneHandshake()],
    ["VncAuth", vncAuthHandshake()],
  ])("forwards a complete %s handshake byte-identically", (_name, handshake) => {
    const filter = createRfbClientMessageFilter();
    expect(filter.filter(handshake)).toEqual({ forward: handshake });
  });

  it.each([
    ["rewrites exclusive", 0, 1],
    ["forwards shared", 1, 1],
  ])("%s ClientInit when it arrives in its own chunk", (_name, clientInit, expected) => {
    const filter = createRfbClientMessageFilter();
    const prefix = Buffer.concat([VERSION, Buffer.from([1])]);
    expect(filter.filter(prefix)).toEqual({ forward: prefix });
    expect(filter.filter(Buffer.from([clientInit]))).toEqual({
      forward: Buffer.from([expected]),
    });
  });

  it("rewrites an exclusive ClientInit batched with the following message", () => {
    const filter = createRfbClientMessageFilter();
    const prefix = Buffer.concat([VERSION, Buffer.from([1])]);
    const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    expect(filter.filter(prefix)).toEqual({ forward: prefix });
    expect(filter.filter(Buffer.concat([Buffer.from([0]), framebufferRequest]))).toEqual({
      forward: Buffer.concat([Buffer.from([1]), framebufferRequest]),
    });
  });

  it("fails closed on unsupported security types", () => {
    const filter = createRfbClientMessageFilter();
    expect(filter.filter(Buffer.concat([VERSION, Buffer.from([19])]))).toEqual({
      error: "unsupported RFB security type 19",
    });
  });

  it("drops input messages while forwarding display configuration and update requests", () => {
    const filter = enterMessagePhase();
    const setPixelFormat = Buffer.alloc(20);
    setPixelFormat[0] = 0;
    const setEncodings = Buffer.alloc(8);
    setEncodings[0] = 2;
    setEncodings.writeUInt16BE(1, 2);
    setEncodings.writeInt32BE(0, 4);
    const framebufferUpdateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const pointerEvent = Buffer.from([5, 1, 0, 10, 0, 20]);
    const cutText = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);

    const result = filter.filter(
      Buffer.concat([
        keyEvent,
        setPixelFormat,
        pointerEvent,
        setEncodings,
        cutText,
        framebufferUpdateRequest,
      ]),
    );

    expect(result).toEqual({
      forward: Buffer.concat([setPixelFormat, setEncodings, framebufferUpdateRequest]),
    });
  });

  it("forwards the fragmented noVNC 1.7 display and flow-control sequence", () => {
    const filter = enterMessagePhase();
    const setPixelFormat = Buffer.alloc(20);
    const setEncodings = Buffer.alloc(100);
    setEncodings[0] = 2;
    setEncodings.writeUInt16BE(24, 2);
    const framebufferUpdateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const clientFence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    const enableContinuousUpdates = Buffer.from([150, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const cutText = Buffer.alloc(16);
    cutText[0] = 6;
    cutText.writeInt32BE(-8, 4);
    const capturedSequence = Buffer.concat([
      setPixelFormat,
      setEncodings,
      framebufferUpdateRequest,
      clientFence,
      enableContinuousUpdates,
      cutText,
      enableContinuousUpdates,
    ]);
    const forwarded: Buffer[] = [];

    for (const byte of capturedSequence) {
      const result = filter.filter(Buffer.of(byte));
      if ("error" in result) {
        throw new Error(result.error);
      }
      forwarded.push(result.forward);
    }

    expect(Buffer.concat(forwarded)).toEqual(
      Buffer.concat([
        setPixelFormat,
        setEncodings,
        framebufferUpdateRequest,
        clientFence,
        enableContinuousUpdates,
        enableContinuousUpdates,
      ]),
    );
  });

  it("uses the ClientFence payload length to preserve message boundaries", () => {
    const filter = enterMessagePhase();
    const clientFence = Buffer.concat([
      Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 3]),
      Buffer.from("abc"),
    ]);
    const framebufferUpdateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);

    expect(filter.filter(clientFence.subarray(0, 10))).toEqual({ forward: Buffer.alloc(0) });
    expect(
      filter.filter(Buffer.concat([clientFence.subarray(10), framebufferUpdateRequest])),
    ).toEqual({
      forward: Buffer.concat([clientFence, framebufferUpdateRequest]),
    });
  });

  it("reassembles a message split across three chunks", () => {
    const filter = enterMessagePhase();
    const completePrefix = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const message = Buffer.alloc(20);
    message[0] = 0;
    message[4] = 32;

    expect(filter.filter(Buffer.concat([completePrefix, message.subarray(0, 3)]))).toEqual({
      forward: completePrefix,
    });
    expect(filter.filter(message.subarray(3, 11))).toEqual({ forward: Buffer.alloc(0) });
    expect(filter.filter(message.subarray(11))).toEqual({ forward: message });
  });

  it("uses the SetEncodings count to route a multi-encoding payload", () => {
    const filter = enterMessagePhase();
    const message = Buffer.alloc(16);
    message[0] = 2;
    message.writeUInt16BE(3, 2);
    message.writeInt32BE(0, 4);
    message.writeInt32BE(16, 8);
    message.writeInt32BE(-223, 12);

    expect(filter.filter(message.subarray(0, 7))).toEqual({ forward: Buffer.alloc(0) });
    expect(filter.filter(message.subarray(7))).toEqual({ forward: message });
  });

  it("fails closed on unknown message types", () => {
    const filter = enterMessagePhase();
    expect(filter.filter(Buffer.from([255]))).toEqual({
      error: "unsupported RFB client message type 255",
    });
  });

  it("fails closed before buffering an oversized variable-length message", () => {
    const filter = enterMessagePhase();
    const header = Buffer.alloc(8);
    header[0] = 6;
    header.writeUInt32BE(64 * 1024, 4);
    expect(filter.filter(header)).toEqual({
      error: "RFB client message exceeds the 64 KiB buffer limit",
    });
  });
});
