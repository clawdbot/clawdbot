/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
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

    handle.disconnect();
    expect(instances[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("forwards socket close metadata through the RFB disconnect callback", async () => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const onDisconnect = vi.fn();
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);

    await client.connect({
      wsUrl: "ws://control.example.test/desktop/observe",
      viewOnly: true,
      target: document.createElement("div"),
      onDisconnect,
    });
    socket.dispatchEvent(new CloseEvent("close", { code: 4000, reason: "control-taken" }));
    instances[0]?.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: true } }));

    expect(onDisconnect).toHaveBeenCalledWith({ code: 4000, reason: "control-taken" });
  });
});
