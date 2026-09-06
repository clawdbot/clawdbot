import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  FakeSocket,
  flush,
  replyFor,
  sendHello,
  wireExtension,
} from "./relay-bridge.test-support.js";
import type { RelayToExtensionMessage } from "./relay-protocol.js";

describe("ExtensionRelayBridge target enumeration", () => {
  it("includes a tab discovered while another native attachment is pending", async () => {
    const bridge = new ExtensionRelayBridge();
    const firstAttach = createDeferred<RelayToExtensionMessage>();
    const nextStep = createDeferred<Record<string, unknown>>();
    const extension = wireExtension(bridge, (message) => {
      if (message.type !== "attach") {
        return replyFor(message);
      }
      if (message.tabId === 1) {
        firstAttach.resolve(message);
      } else {
        nextStep.resolve(message);
      }
      return null;
    });
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const send = client.send.bind(client);
    client.send = (data) => {
      send(data);
      nextStep.resolve(JSON.parse(data));
    };
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const first = await firstAttach.promise;
    extension.handlers.onMessage(
      JSON.stringify({
        type: "tabs",
        tabs: [
          { tabId: 1, url: "https://one.example", title: "One", active: true },
          { tabId: 2, url: "https://two.example", title: "Two", active: false },
        ],
      }),
    );
    extension.handlers.onMessage(JSON.stringify(replyFor(first)));
    const second = await nextStep.promise;
    expect(second).toMatchObject({ type: "attach", tabId: 2 });
    extension.handlers.onMessage(
      JSON.stringify({ type: "result", seq: second.seq, result: { targetId: "target-2" } }),
    );
    await flush();
    expect(client.frames().find((frame) => frame.id === 1)).toMatchObject({
      result: {
        targetInfos: [
          expect.objectContaining({ targetId: "target-1" }),
          expect.objectContaining({ targetId: "target-2" }),
        ],
      },
    });
  });

  it("repairs reconnect attach without undoing a later explicit detach", async () => {
    const bridge = new ExtensionRelayBridge();
    const initialSocket = new FakeSocket();
    const initial = bridge.attachExtensionSocket(initialSocket);
    sendHello(initial);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    expect(initialSocket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);

    const replacement = wireExtension(bridge);
    sendHello(replacement.handlers);
    await flush();

    expect(replacement.socket.frames().filter((frame) => frame.type === "attach")).toEqual([
      expect.objectContaining({ tabId: 1 }),
    ]);
    cdp.onMessage(JSON.stringify({ id: 2, method: "Target.getTargets" }));
    await flush();
    expect(client.frames().find((frame) => frame.id === 2)?.result).toMatchObject({
      targetInfos: [expect.objectContaining({ targetId: "target-1" })],
    });

    const peer = new FakeSocket();
    const peerCdp = bridge.attachCdpClientSocket(peer);
    peerCdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    const attached = client
      .frames()
      .findLast((frame) => frame.method === "Target.attachedToTarget");
    const sessionId = (attached?.params as { sessionId?: string } | undefined)?.sessionId;
    expect(typeof sessionId).toBe("string");
    cdp.onMessage(
      JSON.stringify({ id: 3, method: "Target.detachFromTarget", params: { sessionId } }),
    );
    await flush();
    const attachedEventCount = client
      .frames()
      .filter((frame) => frame.method === "Target.attachedToTarget").length;
    const peerAttachedEventCount = peer
      .frames()
      .filter((frame) => frame.method === "Target.attachedToTarget").length;
    const afterDetach = wireExtension(bridge);
    sendHello(afterDetach.handlers, [
      { tabId: 1, url: "https://example.com", title: "Updated", active: true },
    ]);
    await flush();

    expect(afterDetach.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);
    expect(
      client.frames().filter((frame) => frame.method === "Target.attachedToTarget"),
    ).toHaveLength(attachedEventCount);
    expect(
      peer.frames().filter((frame) => frame.method === "Target.attachedToTarget"),
    ).toHaveLength(peerAttachedEventCount + 1);
    cdp.onMessage(JSON.stringify({ id: 4, method: "Target.getTargets" }));
    await flush();
    expect(afterDetach.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);
    expect(client.frames().find((frame) => frame.id === 4)?.result).toMatchObject({
      targetInfos: [expect.objectContaining({ targetId: "target-1", attached: true })],
    });
    expect(
      client.frames().filter((frame) => frame.method === "Target.attachedToTarget"),
    ).toHaveLength(attachedEventCount);

    afterDetach.handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    afterDetach.handlers.onMessage(
      JSON.stringify({
        type: "tabs",
        tabs: [{ tabId: 1, url: "https://reused.example", title: "Reused", active: true }],
      }),
    );
    await flush();
    expect(
      client.frames().filter((frame) => frame.method === "Target.attachedToTarget"),
    ).toHaveLength(attachedEventCount + 1);
  });

  it("does not project a disconnected zero-tab extension as authoritative empty", async () => {
    const bridge = new ExtensionRelayBridge();
    const extension = wireExtension(bridge);
    sendHello(extension.handlers, []);
    extension.handlers.onClose();
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    cdp.onMessage(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    await flush();

    expect(client.frames().find((frame) => frame.id === 1)).toMatchObject({
      error: { message: expect.stringMatching(/extension.*disconnected/i) },
    });
  });

  it("refreshes native identities without attaching a discovery-only client", async () => {
    const bridge = new ExtensionRelayBridge();
    let targetId = "target-1";
    let unavailable = false;
    const extension = wireExtension(bridge, (message) =>
      message.type === "attach"
        ? unavailable
          ? { type: "error", seq: message.seq, message: "native target unavailable" }
          : { type: "result", seq: message.seq, result: { targetId } }
        : replyFor(message),
    );
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    cdp.onMessage(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    await flush();

    expect(extension.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);
    expect(client.frames().find((frame) => frame.id === 1)).toMatchObject({
      result: {
        targetInfos: [expect.objectContaining({ targetId: "target-1", attached: false })],
      },
    });
    expect(client.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(false);

    targetId = "replacement-target";
    cdp.onMessage(JSON.stringify({ id: 2, method: "Target.getTargets" }));
    await flush();

    expect(client.frames().find((frame) => frame.id === 2)).toMatchObject({
      result: {
        targetInfos: [expect.objectContaining({ targetId: "replacement-target", attached: false })],
      },
    });
    expect(client.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(false);

    unavailable = true;
    cdp.onMessage(JSON.stringify({ id: 3, method: "Target.getTargets" }));
    await flush();
    expect(client.frames().find((frame) => frame.id === 3)).toMatchObject({
      error: { message: "Target identities are unavailable" },
    });
  });

  it("rejects discovery when the previous native retirement fails", async () => {
    const bridge = new ExtensionRelayBridge();
    const retirement = createDeferred<Extract<RelayToExtensionMessage, { type: "detach" }>>();
    const extension = wireExtension(bridge, (message) => {
      if (message.type === "detach") {
        retirement.resolve(message);
        return null;
      }
      return replyFor(message);
    });
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const detach = await retirement.promise;
    cdp.onMessage(JSON.stringify({ id: 2, method: "Target.getTargets" }));
    extension.handlers.onMessage(
      JSON.stringify({ type: "error", seq: detach.seq, message: "native detach failed" }),
    );
    await flush();

    expect(client.frames().find((frame) => frame.id === 2)).toMatchObject({
      error: { message: "Target identities are unavailable" },
    });
  });

  it("repairs a failed initial auto-attach before Target.getTargets", async () => {
    const bridge = new ExtensionRelayBridge();
    let attachAttempts = 0;
    const extension = wireExtension(bridge, (message) => {
      if (message.type === "attach" && attachAttempts++ === 0) {
        return { type: "error", seq: message.seq, message: "tab generation changed" };
      }
      return replyFor(message);
    });
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    expect(client.frames().find((frame) => frame.id === 1)?.error).toBeUndefined();
    expect(client.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(false);

    cdp.onMessage(JSON.stringify({ id: 2, method: "Target.getTargets" }));
    await flush();

    expect(extension.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(2);
    expect(client.frames().find((frame) => frame.id === 2)).toMatchObject({
      result: { targetInfos: [expect.objectContaining({ targetId: "target-1" })] },
    });
    expect(client.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(true);
  });

  it("publishes a shared recovered attachment to every waiting auto-attach client", async () => {
    const bridge = new ExtensionRelayBridge();
    let attachAttempts = 0;
    const extension = wireExtension(bridge, (message) => {
      if (message.type === "attach" && attachAttempts++ === 0) {
        return { type: "error", seq: message.seq, message: "first client lost its claim" };
      }
      return replyFor(message);
    });
    sendHello(extension.handlers);
    const first = new FakeSocket();
    const firstCdp = bridge.attachCdpClientSocket(first);
    firstCdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

    const second = new FakeSocket();
    const secondCdp = bridge.attachCdpClientSocket(second);
    secondCdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    expect(second.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(true);
    expect(first.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(true);
    const firstAttachedEventCount = first
      .frames()
      .filter((frame) => frame.method === "Target.attachedToTarget").length;

    firstCdp.onMessage(JSON.stringify({ id: 2, method: "Target.getTargets" }));
    await flush();

    expect(extension.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(2);
    expect(first.frames().find((frame) => frame.id === 2)?.error).toBeUndefined();
    expect(
      first.frames().filter((frame) => frame.method === "Target.attachedToTarget"),
    ).toHaveLength(firstAttachedEventCount);
  });

  it("does not project a mixed target list when identity repair fails", async () => {
    const bridge = new ExtensionRelayBridge();
    const extension = wireExtension(bridge, (message) =>
      message.type === "attach" && message.tabId === 2
        ? { type: "error", seq: message.seq, message: "tab became unavailable" }
        : replyFor(message),
    );
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    cdp.onMessage(
      JSON.stringify({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: false } }),
    );
    extension.handlers.onMessage(
      JSON.stringify({
        type: "tabs",
        tabs: [
          { tabId: 1, url: "https://one.example", title: "One", active: true },
          { tabId: 2, url: "https://two.example", title: "Two", active: false },
        ],
      }),
    );
    await flush();

    cdp.onMessage(JSON.stringify({ id: 3, method: "Target.getTargets" }));
    await flush();

    expect(client.frames().find((frame) => frame.id === 3)).toMatchObject({
      error: { message: expect.stringMatching(/target identit.*unavailable/i) },
    });
  });
});
