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
      readonly options?: { credentials?: { password: string } },
    ) {
      super();
      instances.push(this);
    }
  }
  return { Rfb: FakeRfb as RfbConstructor, instances };
}

describe("DesktopClient", () => {
  it.each([
    [
      "http://control.example.test/chat",
      "ws://control.example.test/worker-desktop/observe?token=abc",
    ],
    [
      "https://control.example.test/chat",
      "wss://control.example.test/worker-desktop/observe?token=abc",
    ],
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
      wsUrl: "/worker-desktop/observe?token=abc",
      password: "secret",
      viewOnly: true,
      target,
    });

    expect(sockets[0]?.url).toBe(expectedUrl);
    expect(instances[0]?.target).toBe(target);
    expect(instances[0]?.channel).toBe(sockets[0]);
  });

  it("propagates RFB options and disconnects through the returned handle", async () => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/worker-desktop/observe");
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);

    const handle = await client.connect({
      gatewayUrl: "ws://control.example.test",
      wsUrl: "/worker-desktop/observe",
      password: "secret",
      background: "rgb(8, 8, 8)",
      viewOnly: false,
      target: document.createElement("div"),
    });

    expect(instances[0]?.background).toBe("rgb(8, 8, 8)");
    expect(instances[0]?.viewOnly).toBe(false);
    expect(instances[0]?.scaleViewport).toBe(true);
    expect(instances[0]?.options).toEqual({ credentials: { password: "secret" } });

    handle.disconnect();
    expect(instances[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("forwards socket close metadata through the RFB disconnect callback", async () => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/worker-desktop/observe");
    const onDisconnect = vi.fn();
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);

    await client.connect({
      wsUrl: "ws://control.example.test/worker-desktop/observe",
      viewOnly: true,
      target: document.createElement("div"),
      onDisconnect,
    });
    socket.dispatchEvent(new CloseEvent("close", { code: 4000, reason: "control-taken" }));
    instances[0]?.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: true } }));

    expect(onDisconnect).toHaveBeenCalledWith({ code: 4000, reason: "control-taken" });
  });
});
