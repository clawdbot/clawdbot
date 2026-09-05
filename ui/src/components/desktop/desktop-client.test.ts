/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { DesktopClient } from "./desktop-client.ts";

type RfbConstructor = NonNullable<ConstructorParameters<typeof DesktopClient>[0]>;
type RfbClient = InstanceType<RfbConstructor>;

class FakeSocket extends EventTarget {
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }
}

function createFakeRfb() {
  const instances: FakeRfb[] = [];
  class FakeRfb extends EventTarget implements RfbClient {
    background = "";
    viewOnly = false;
    scaleViewport = false;
    readonly disconnect = vi.fn();

    constructor(
      readonly target: HTMLElement,
      readonly channel: string | WebSocket,
      readonly options?: { credentials?: { username?: string; password?: string } },
    ) {
      super();
      instances.push(this);
    }
  }
  return { Rfb: FakeRfb as RfbConstructor, instances };
}

describe("DesktopClient", () => {
  it.each([false, true])(
    "opens a socket after the RFB loader only while the operation remains current (%s)",
    async (remainsCurrent) => {
      const { Rfb, instances } = createFakeRfb();
      const loaded = createDeferred<RfbConstructor>();
      const createSocket = vi.fn((url: string) => new FakeSocket(url) as unknown as WebSocket);
      const client = new DesktopClient(undefined, createSocket, () => loaded.promise);
      let current = true;
      const pending = client.connect({
        wsUrl: "ws://control.example.test/desktop/observe",
        viewOnly: false,
        target: document.createElement("div"),
        isCurrent: () => current,
      });
      const result = pending.then(
        (handle) => ({ handle, error: undefined }),
        (error: unknown) => ({ handle: undefined, error }),
      );
      try {
        expect(createSocket).not.toHaveBeenCalled();
        current = remainsCurrent;
        loaded.resolve(Rfb);
        const outcome = await result;
        expect(createSocket).toHaveBeenCalledTimes(remainsCurrent ? 1 : 0);
        if (remainsCurrent) {
          expect(outcome.error).toBeUndefined();
          expect(instances).toHaveLength(1);
        } else {
          expect(outcome.error).toMatchObject({ name: "AbortError" });
          expect(instances).toHaveLength(0);
        }
      } finally {
        loaded.resolve(Rfb);
        (await result).handle?.disconnect();
      }
    },
  );

  it.each([
    ["http://control.example.test/chat", "ws://control.example.test/desktop/observe?token=abc"],
    ["https://control.example.test/chat", "wss://control.example.test/desktop/observe?token=abc"],
  ])("resolves relative observer URLs against %s", async (gatewayUrl, expectedUrl) => {
    const { Rfb, instances } = createFakeRfb();
    const sockets: FakeSocket[] = [];
    const client = new DesktopClient(Rfb, (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const target = document.createElement("div");

    await client.connect({
      gatewayUrl,
      isCurrent: () => true,
      wsUrl: "/desktop/observe?token=abc",
      credentials: { password: "secret" },
      viewOnly: true,
      target,
    });

    expect(sockets[0]?.url).toBe(expectedUrl);
    expect(instances[0]?.target).toBe(target);
    expect(instances[0]?.channel).toBe(sockets[0]);
  });

  it("propagates RFB options and disconnects through the returned handle", async () => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);
    const target = document.createElement("div");
    const canvas = document.createElement("canvas");
    const onKeyDown = vi.fn();
    canvas.addEventListener("keydown", onKeyDown);
    target.append(canvas);

    const handle = await client.connect({
      gatewayUrl: "ws://control.example.test",
      isCurrent: () => true,
      wsUrl: "/desktop/observe",
      credentials: { username: "operator", password: "secret" },
      background: "rgb(8, 8, 8)",
      viewOnly: false,
      scaleViewport: false,
      target,
    });

    expect(instances[0]?.background).toBe("rgb(8, 8, 8)");
    expect(instances[0]?.viewOnly).toBe(false);
    expect(instances[0]?.scaleViewport).toBe(false);
    expect(instances[0]?.options).toEqual({
      credentials: { username: "operator", password: "secret" },
    });

    handle.setScaleViewport?.(true);
    expect(instances[0]?.scaleViewport).toBe(true);
    handle.sendKeyboardEvent?.(new KeyboardEvent("keydown", { key: "k", code: "KeyK" }));
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect((onKeyDown.mock.calls[0]?.[0] as KeyboardEvent | undefined)?.key).toBe("k");
    handle.sendText?.("m");
    handle.sendBackspace?.();
    expect(onKeyDown.mock.calls.map((call) => (call[0] as KeyboardEvent | undefined)?.key)).toEqual(
      ["k", "m", "Backspace"],
    );

    handle.disableInput();
    expect(instances[0]?.viewOnly).toBe(true);
    handle.disconnect();
    handle.disconnect();
    expect(instances[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    { clean: true, close: { code: 4000, reason: "control-taken" } },
    { clean: false, close: { code: 1008, reason: "authentication rejected" } },
    { clean: false, close: { code: 1006, reason: "" } },
    { clean: false, close: undefined },
    { clean: true, close: undefined },
  ])("preserves RFB clean=$clean with socket close $close", async ({ clean, close }) => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const onDisconnect = vi.fn();
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);

    const handle = await client.connect({
      wsUrl: "ws://control.example.test/desktop/observe",
      isCurrent: () => true,
      viewOnly: true,
      target: document.createElement("div"),
      onDisconnect,
    });
    onDisconnect.mockImplementation(() => handle.disconnect());
    if (close) {
      socket.dispatchEvent(new CloseEvent("close", close));
    }
    instances[0]?.dispatchEvent(new CustomEvent("disconnect", { detail: { clean } }));

    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith({ ...close, clean });
    handle.disconnect();
    expect(instances[0]?.disconnect).not.toHaveBeenCalled();
    if (!close) {
      socket.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      expect(onDisconnect).toHaveBeenCalledExactlyOnceWith({ clean });
    }
  });

  it.each([
    ["LF", "é\nΩ", ["é", "Enter", "Ω"]],
    ["CRLF", "é\r\nΩ", ["é", "Enter", "Ω"]],
    ["CR", "é\rΩ", ["é", "Enter", "Ω"]],
    ["astral Unicode", "🦞\nΩ", ["\ud83e", "\udd9e", "Enter", "Ω"]],
    ["blank lines", "\n\r\n\r", ["Enter", "Enter", "Enter"]],
  ] as const)("sends %s text line breaks as single Enter presses", async (_name, text, keys) => {
    const { Rfb } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);
    const target = document.createElement("div");
    const canvas = document.createElement("canvas");
    const events: KeyboardEvent[] = [];
    const onKey = (event: KeyboardEvent) => events.push(event);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    target.append(canvas);
    const handle = await client.connect({
      wsUrl: "ws://control.example.test/desktop/observe",
      isCurrent: () => true,
      viewOnly: false,
      target,
    });

    handle.sendText?.(text);

    expect(events.map(({ type, key, code }) => ({ type, key, code }))).toEqual(
      keys.map((key) => ({ type: "keydown", key, code: "Unidentified" })),
    );
    handle.disconnect();
  });
});
