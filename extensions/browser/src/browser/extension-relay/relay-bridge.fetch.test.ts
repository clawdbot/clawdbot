import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  flush,
  FakeSocket,
  replyFor,
  defaultTabs,
  sendHello,
  wireExtension,
} from "./relay-bridge.test-support.js";
import type { RelayToExtensionMessage } from "./relay-protocol.js";

function connectRelayClient(bridge: ExtensionRelayBridge) {
  const socket = new FakeSocket();
  const handlers = bridge.attachCdpClientSocket(socket);
  let nextId = 1;
  const send = (method: string, sessionId?: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    handlers.onMessage(JSON.stringify({ id, method, sessionId, params }));
    return id;
  };
  const response = (id: number) => socket.frames().find((frame) => frame.id === id);
  return {
    socket,
    send,
    response,
    close: handlers.onClose,
    async request(method: string, sessionId?: string, params?: Record<string, unknown>) {
      const id = send(method, sessionId, params);
      await flush();
      return response(id);
    },
  };
}

type RelayClient = ReturnType<typeof connectRelayClient>;

function sessionFrom(value: unknown): string {
  expect(value).toMatchObject({ sessionId: expect.any(String) });
  return (value as { sessionId: string }).sessionId;
}

function rootSession(client: RelayClient, targetId = "target-1"): string {
  const attached = client.socket.frames().find((frame) => {
    const params = frame.params as { targetInfo?: { targetId?: string } } | undefined;
    return frame.method === "Target.attachedToTarget" && params?.targetInfo?.targetId === targetId;
  });
  return sessionFrom(attached?.params);
}

function fetchEvents(client: RelayClient, sessionId?: string) {
  return client.socket
    .frames()
    .filter(
      (frame) =>
        (frame.method === "Fetch.requestPaused" || frame.method === "Fetch.authRequired") &&
        (sessionId === undefined || frame.sessionId === sessionId),
    );
}

function pausedRequestId(client: RelayClient, sessionId: string): string {
  const params = fetchEvents(client, sessionId).at(-1)?.params;
  expect(params).toMatchObject({ requestId: expect.any(String) });
  return (params as { requestId: string }).requestId;
}

const ownershipError = { error: { code: expect.any(Number), message: expect.any(String) } };

describe("ExtensionRelayBridge Fetch ownership", () => {
  let bridge: ExtensionRelayBridge;
  let extension: ReturnType<typeof wireExtension>;
  let reply: typeof replyFor;
  let owner: RelayClient;
  let observer: RelayClient;
  let sessionId: string;
  let observerSessionId: string;

  beforeEach(async () => {
    bridge = new ExtensionRelayBridge();
    reply = replyFor;
    extension = wireExtension(bridge, (message) => reply(message));
    sendHello(extension.handlers, [
      ...defaultTabs(),
      { tabId: 2, url: "https://other.example", title: "Other", active: false },
    ]);
    owner = connectRelayClient(bridge);
    observer = connectRelayClient(bridge);
    await Promise.all(
      [owner, observer].map((client) =>
        client.request("Target.setAutoAttach", undefined, { autoAttach: true, flatten: true }),
      ),
    );
    sessionId = rootSession(owner);
    observerSessionId = rootSession(observer);
  });

  afterEach(async () => {
    bridge.dispose();
    await flush();
  });

  function emitPaused(
    requestId: string,
    scope: { tabId: number; sessionId?: string } = { tabId: 1 },
    method = "Fetch.requestPaused",
    extra: Record<string, unknown> = {},
  ) {
    extension.handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        ...scope,
        method,
        params: {
          requestId,
          ...extra,
          request: { url: "https://example.com/blocked", method: "GET", headers: {} },
          frameId: "frame-1",
          resourceType: "Document",
          ...(method === "Fetch.authRequired"
            ? { authChallenge: { origin: "https://example.com", scheme: "basic", realm: "test" } }
            : {}),
        },
      }),
    );
  }

  function fetchCommands() {
    return extension.socket
      .frames()
      .filter((frame) => frame.type === "cdp" && String(frame.method).startsWith("Fetch."));
  }

  it.each([
    { event: "Fetch.requestPaused", resolve: "Fetch.continueRequest", params: {} },
    {
      event: "Fetch.authRequired",
      resolve: "Fetch.continueWithAuth",
      params: { authChallengeResponse: { response: "CancelAuth" } },
    },
  ])("delivers $event only to its owner and rejects another client's guessed ID", async (entry) => {
    expect(
      await owner.request("Fetch.enable", sessionId, { handleAuthRequests: true }),
    ).toMatchObject({ result: {} });
    emitPaused("physical-request", { tabId: 1 }, entry.event);
    const requestId = pausedRequestId(owner, sessionId);

    expect.soft(fetchEvents(observer)).toEqual([]);
    const resolution = { ...entry.params, requestId };
    expect
      .soft(await observer.request(entry.resolve, observerSessionId, resolution))
      .toMatchObject(ownershipError);
    expect.soft(fetchCommands().filter((frame) => frame.method === entry.resolve)).toEqual([]);

    expect(await owner.request(entry.resolve, sessionId, resolution)).toMatchObject({ result: {} });
    expect.soft(fetchCommands().filter((frame) => frame.method === entry.resolve)).toEqual([
      expect.objectContaining({
        tabId: 1,
        params: { ...entry.params, requestId: "physical-request" },
      }),
    ]);
  });

  it("rejects competing enable and ignores nonowner disable without blocking Page or another tab", async () => {
    expect(await owner.request("Fetch.enable", sessionId)).toMatchObject({ result: {} });
    await observer.request("Fetch.disable", observerSessionId);
    expect.soft(fetchCommands().filter((frame) => frame.method === "Fetch.disable")).toEqual([]);

    const [competing, page, otherTab] = await Promise.all([
      observer.request("Fetch.enable", observerSessionId),
      observer.request("Page.getFrameTree", observerSessionId),
      observer.request("Fetch.enable", rootSession(observer, "target-2")),
    ]);
    expect.soft(competing).toMatchObject(ownershipError);
    expect(page).toMatchObject({ result: {} });
    expect(otherTab).toMatchObject({ result: {} });
    expect
      .soft(fetchCommands().filter((frame) => frame.method === "Fetch.enable"))
      .toEqual([expect.objectContaining({ tabId: 1 }), expect.objectContaining({ tabId: 2 })]);

    emitPaused("owner-still-live");
    const requestId = pausedRequestId(owner, sessionId);
    expect.soft(fetchEvents(observer, observerSessionId)).toEqual([]);
    expect(await owner.request("Fetch.continueRequest", sessionId, { requestId })).toMatchObject({
      result: {},
    });
    emitPaused("other-tab-request", { tabId: 2 });
    expect(fetchEvents(observer, rootSession(observer, "target-2"))).toHaveLength(1);
    expect.soft(fetchEvents(owner, rootSession(owner, "target-2"))).toEqual([]);
  });

  it.each(["root", "alias"])(
    "keeps a %s Fetch owner separate from another session on the same client",
    async (kind) => {
      const browser = await owner.request("Target.attachToBrowserTarget");
      const browserSession = sessionFrom(browser?.result);
      const attached = await owner.request("Target.attachToTarget", browserSession, {
        targetId: "target-1",
        flatten: true,
      });
      const alias = sessionFrom(attached?.result);
      const ownerSession = kind === "root" ? sessionId : alias;
      const siblingSession = kind === "root" ? alias : sessionId;
      expect(await owner.request("Fetch.enable", ownerSession)).toMatchObject({ result: {} });
      emitPaused("alias-request");
      const requestId = pausedRequestId(owner, ownerSession);

      expect.soft(fetchEvents(owner, siblingSession)).toEqual([]);
      expect
        .soft(await owner.request("Fetch.continueRequest", siblingSession, { requestId }))
        .toMatchObject(ownershipError);
      await owner.request("Fetch.disable", siblingSession);
      expect.soft(fetchCommands().filter((frame) => frame.method === "Fetch.disable")).toEqual([]);
      expect
        .soft(await owner.request("Fetch.enable", siblingSession))
        .toMatchObject(ownershipError);
      expect(
        await owner.request("Fetch.continueRequest", ownerSession, { requestId }),
      ).toMatchObject({
        result: {},
      });
    },
  );

  it("fails the closing owner's pending request before disabling, then releases the scope to a connected client", async () => {
    expect(await owner.request("Fetch.enable", sessionId)).toMatchObject({ result: {} });
    emitPaused("abandoned-request");
    pausedRequestId(owner, sessionId);
    reply = (message) =>
      message.type === "cdp" && message.method === "Fetch.failRequest" ? null : replyFor(message);
    owner.close();
    await flush();

    const cleanup = fetchCommands().find((frame) => frame.method === "Fetch.failRequest");
    expect.soft(cleanup).toMatchObject({ tabId: 1, params: { requestId: "abandoned-request" } });
    expect.soft(fetchCommands().filter((frame) => frame.method === "Fetch.disable")).toEqual([]);
    expect(await observer.request("Page.getFrameTree", observerSessionId)).toMatchObject({
      result: {},
    });
    if (cleanup) {
      extension.handlers.onMessage(
        JSON.stringify({ type: "result", seq: cleanup.seq, result: {} }),
      );
    }
    await flush();

    expect
      .soft(fetchCommands().map((frame) => frame.method))
      .toEqual(["Fetch.enable", "Fetch.failRequest", "Fetch.disable"]);
    expect(extension.socket.frames().filter((frame) => frame.type === "detach")).toEqual([]);
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject({ result: {} });
    emitPaused("successor-request");
    expect(fetchEvents(observer, observerSessionId).at(-1)).toMatchObject({
      params: { requestId: expect.any(String) },
    });
  });

  it("retires the physical scope when owner-close cleanup is completion-ambiguous", async () => {
    expect(await owner.request("Fetch.enable", sessionId)).toMatchObject({ result: {} });
    emitPaused("abandoned-request");
    pausedRequestId(owner, sessionId);
    reply = (message) =>
      message.type === "cdp" && message.method === "Fetch.failRequest"
        ? { type: "error", seq: message.seq, message: "cleanup completion unknown" }
        : replyFor(message);
    owner.close();
    await flush();
    await flush();

    expect
      .soft(fetchCommands().map((frame) => frame.method))
      .toEqual(["Fetch.enable", "Fetch.failRequest"]);
    expect
      .soft(extension.socket.frames().filter((frame) => frame.type === "detach"))
      .toEqual([expect.objectContaining({ tabId: 1 })]);
    expect(observer.socket.closed).toBe(false);
    expect(await observer.request("Page.getFrameTree", observerSessionId)).toMatchObject(
      ownershipError,
    );
  });

  it("rejects a stale request ID after disable and successor enable without disturbing the new request", async () => {
    expect(await owner.request("Fetch.enable", sessionId)).toMatchObject({ result: {} });
    emitPaused("old-request");
    const staleId = pausedRequestId(owner, sessionId);
    expect(await owner.request("Fetch.disable", sessionId)).toMatchObject({ result: {} });
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject({ result: {} });
    emitPaused("new-request");
    const currentId = pausedRequestId(observer, observerSessionId);
    const beforeResolution = fetchCommands().length;

    expect
      .soft(
        await observer.request("Fetch.continueRequest", observerSessionId, { requestId: staleId }),
      )
      .toMatchObject(ownershipError);
    expect.soft(fetchCommands()).toHaveLength(beforeResolution);
    expect(
      await observer.request("Fetch.continueRequest", observerSessionId, { requestId: currentId }),
    ).toMatchObject({
      result: {},
    });
    expect(fetchCommands().at(-1)).toMatchObject({ params: { requestId: "new-request" } });
  });

  it("owns child Fetch independently of the root physical scope", async () => {
    await owner.request("Target.setAutoAttach", sessionId, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await observer.request("Target.setAutoAttach", observerSessionId, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const childSession = "child-frame";
    extension.handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        tabId: 1,
        method: "Target.attachedToTarget",
        params: {
          sessionId: childSession,
          targetInfo: { targetId: "frame-target", type: "iframe" },
          waitingForDebugger: false,
        },
      }),
    );
    const ownerChild = rootSession(owner, "frame-target");
    const observerChild = rootSession(observer, "frame-target");
    expect(await owner.request("Fetch.enable", ownerChild)).toMatchObject({ result: {} });
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject({ result: {} });
    emitPaused("child-request", { tabId: 1, sessionId: childSession });
    const requestId = pausedRequestId(owner, ownerChild);

    expect.soft(fetchEvents(observer, observerChild)).toEqual([]);
    expect
      .soft(await observer.request("Fetch.continueRequest", observerChild, { requestId }))
      .toMatchObject(ownershipError);
    expect(await owner.request("Fetch.continueRequest", ownerChild, { requestId })).toMatchObject({
      result: {},
    });
    expect(fetchCommands().at(-1)).toMatchObject({
      tabId: 1,
      sessionId: childSession,
      params: { requestId: "child-request" },
    });
  });

  it("retires the physical scope when enable errors before a connected client reattaches", async () => {
    let heldEnable: Extract<RelayToExtensionMessage, { type: "cdp" }> | undefined;
    reply = (message) => {
      if (message.type === "cdp" && message.method === "Fetch.enable") {
        heldEnable ??= message;
        return null;
      }
      return replyFor(message);
    };
    const enabling = owner.send("Fetch.enable", sessionId);
    await flush();
    expect(heldEnable).toMatchObject({ method: "Fetch.enable", tabId: 1 });
    expect
      .soft(await observer.request("Fetch.enable", observerSessionId))
      .toMatchObject(ownershipError);
    expect.soft(fetchCommands()).toHaveLength(1);
    reply = replyFor;
    extension.handlers.onMessage(
      JSON.stringify({ type: "error", seq: heldEnable?.seq, message: "enable rejected" }),
    );
    await flush();
    expect(owner.response(enabling)).toMatchObject({ error: { message: "enable rejected" } });
    expect
      .soft(extension.socket.frames().filter((frame) => frame.type === "detach"))
      .toEqual([expect.objectContaining({ tabId: 1 })]);
    expect(owner.socket.closed).toBe(false);
    expect(observer.socket.closed).toBe(false);

    const attached = await observer.request("Target.attachToTarget", undefined, {
      targetId: "target-1",
      flatten: true,
    });
    const replacementSessionId = sessionFrom(attached?.result);
    expect(replacementSessionId).not.toBe(observerSessionId);
    expect(await observer.request("Fetch.enable", replacementSessionId)).toMatchObject({
      result: {},
    });
    emitPaused("after-rejected-enable");
    expect(fetchEvents(observer, replacementSessionId)).toHaveLength(1);
    expect.soft(fetchEvents(owner)).toEqual([]);
  });

  it("cleans up a successful enable reply that arrives after its client closes", async () => {
    let heldEnable: Extract<RelayToExtensionMessage, { type: "cdp" }> | undefined;
    reply = (message) => {
      if (message.type === "cdp" && message.method === "Fetch.enable") {
        heldEnable = message;
        return null;
      }
      return replyFor(message);
    };
    const enabling = owner.send("Fetch.enable", sessionId);
    await flush();
    expect(heldEnable).toMatchObject({ method: "Fetch.enable", tabId: 1 });
    owner.close();
    reply = replyFor;
    extension.handlers.onMessage(
      JSON.stringify({ type: "result", seq: heldEnable?.seq, result: {} }),
    );
    await flush();

    expect(owner.response(enabling)).toBeUndefined();
    expect
      .soft(fetchCommands().map((frame) => frame.method))
      .toEqual(["Fetch.enable", "Fetch.disable"]);
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject({ result: {} });
    emitPaused("after-closed-enable");
    expect(fetchEvents(observer, observerSessionId)).toHaveLength(1);
  });

  it("keeps raw and minted response streams private without intercepting unrelated IO", async () => {
    reply = (message) =>
      message.type === "cdp" && message.method === "Fetch.takeResponseBodyAsStream"
        ? { type: "result", seq: message.seq, result: { stream: "native-stream" } }
        : replyFor(message);
    await owner.request("Fetch.enable", sessionId);
    emitPaused("response", { tabId: 1 }, "Fetch.requestPaused", { responseStatusCode: 200 });
    const body = await owner.request("Fetch.takeResponseBodyAsStream", sessionId, {
      requestId: pausedRequestId(owner, sessionId),
    });
    const handle = asOptionalRecord(body?.result)?.stream;
    if (typeof handle !== "string") {
      throw new Error("Missing response stream");
    }
    for (const method of ["IO.read", "IO.close"]) {
      for (const raw of [handle, "native-stream"]) {
        expect(await observer.request(method, observerSessionId, { handle: raw })).toMatchObject(
          ownershipError,
        );
      }
    }
    expect(
      extension.socket
        .frames()
        .filter((frame) => frame.method === "IO.read" || frame.method === "IO.close"),
    ).toEqual([]);
    expect(await owner.request("IO.read", sessionId, { handle })).toMatchObject({ result: {} });
    expect(
      await observer.request("IO.read", observerSessionId, { handle: "unrelated-domain" }),
    ).toMatchObject({ result: {} });
    expect(
      extension.socket
        .frames()
        .filter((frame) => frame.method === "IO.read")
        .map((frame) => frame.params),
    ).toEqual([{ handle: "native-stream" }, { handle: "unrelated-domain" }]);
    expect(owner.socket.closed).toBe(false);
    expect(observer.socket.closed).toBe(false);
  });

  it("retires the native root of an uncertain child without disturbing another tab", async () => {
    await owner.request("Target.setAutoAttach", sessionId, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await observer.request("Target.setAutoAttach", observerSessionId, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    extension.handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        tabId: 1,
        method: "Target.attachedToTarget",
        params: { sessionId: "child", targetInfo: { targetId: "child-target", type: "iframe" } },
      }),
    );
    reply = (message) =>
      message.type === "cdp" && message.sessionId === "child" && message.method === "Fetch.enable"
        ? { type: "error", seq: message.seq, message: "native completion unknown" }
        : replyFor(message);
    expect(await owner.request("Fetch.enable", rootSession(owner, "child-target"))).toMatchObject(
      ownershipError,
    );
    await flush();
    expect(extension.socket.frames().filter((frame) => frame.type === "detach")).toEqual([
      expect.objectContaining({ tabId: 1 }),
    ]);
    expect(await observer.request("Runtime.enable", observerSessionId)).toMatchObject(
      ownershipError,
    );
    expect(
      await observer.request("Page.getFrameTree", rootSession(observer, "target-2")),
    ).toMatchObject({ result: {} });
    expect(owner.socket.closed).toBe(false);
    expect(observer.socket.closed).toBe(false);
  });

  it("fences admission immediately and waits for cleanup and native detach before successor attach", async () => {
    await owner.request("Fetch.enable", sessionId);
    emitPaused("observed");
    await observer.request("Target.detachFromTarget", undefined, { sessionId: observerSessionId });
    reply = (message) =>
      (message.type === "cdp" && message.method === "Fetch.failRequest") ||
      message.type === "detach"
        ? null
        : replyFor(message);
    const closing = owner.send("Target.detachFromTarget", undefined, { sessionId });
    await flush();
    const attaching = observer.send("Target.attachToTarget", undefined, { targetId: "target-1" });
    await flush();
    expect(await owner.request("Page.getFrameTree", sessionId)).toMatchObject(ownershipError);
    expect(observer.response(attaching)).toBeUndefined();
    expect(
      extension.socket.frames().filter((frame) => frame.type === "attach" && frame.tabId === 1),
    ).toHaveLength(1);
    const cleanup = fetchCommands().find((frame) => frame.method === "Fetch.failRequest")!;
    extension.handlers.onMessage(JSON.stringify({ type: "result", seq: cleanup.seq, result: {} }));
    await flush();
    expect(observer.response(attaching)).toBeUndefined();
    const detaching = extension.socket
      .frames()
      .find((frame) => frame.type === "detach" && frame.tabId === 1)!;
    reply = replyFor;
    extension.handlers.onMessage(
      JSON.stringify({ type: "result", seq: detaching.seq, result: {} }),
    );
    await flush();
    expect(owner.response(closing)).toMatchObject({ result: {} });
    const replacement = sessionFrom(observer.response(attaching)?.result);
    expect(replacement).not.toBe(sessionId);
    expect(await observer.request("Runtime.enable", replacement)).toMatchObject({ result: {} });
    expect(fetchCommands().some((frame) => frame.method === "Fetch.disable")).toBe(false);
  });

  it.each(["last logical session", "owner with a live sibling"])(
    "bounds retirement of a hung body read and evaluation for %s",
    async (ending) => {
      await owner.request("Fetch.enable", sessionId);
      emitPaused("body", { tabId: 1 }, "Fetch.requestPaused", { responseStatusCode: 200 });
      const requestId = pausedRequestId(owner, sessionId);
      if (ending === "last logical session") {
        await observer.request("Target.detachFromTarget", undefined, {
          sessionId: observerSessionId,
        });
      }
      reply = (message) =>
        message.type === "cdp" &&
        ["Fetch.getResponseBody", "Runtime.evaluate", "Fetch.failRequest"].includes(message.method)
          ? null
          : replyFor(message);
      const body = owner.send("Fetch.getResponseBody", sessionId, { requestId });
      const evaluation = owner.send("Runtime.evaluate", sessionId);
      await flush();
      emitPaused("known-request");
      vi.useFakeTimers();
      try {
        owner.send("Target.detachFromTarget", undefined, { sessionId });
        await vi.advanceTimersByTimeAsync(2001);
        expect(
          extension.socket.frames().filter((frame) => frame.type === "detach" && frame.tabId === 1),
        ).toHaveLength(1);
        expect(owner.response(body)).toMatchObject(ownershipError);
        expect(owner.response(evaluation)).toMatchObject(ownershipError);
        expect(fetchCommands().filter((frame) => frame.method === "Fetch.failRequest")).toEqual([
          expect.objectContaining({
            params: { requestId: "known-request", errorReason: "Aborted" },
          }),
        ]);
        expect(fetchCommands().some((frame) => frame.method === "Fetch.disable")).toBe(false);
        expect(owner.socket.closed).toBe(false);
        expect(observer.socket.closed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("disposes held cleanup on extension loss without sending through its successor", async () => {
    await owner.request("Fetch.enable", sessionId);
    emitPaused("observed");
    await observer.request("Target.detachFromTarget", undefined, { sessionId: observerSessionId });
    reply = (message) =>
      message.type === "cdp" && message.method === "Fetch.failRequest" ? null : replyFor(message);
    owner.send("Target.detachFromTarget", undefined, { sessionId });
    await flush();
    const reattaching = observer.send("Target.attachToTarget", undefined, { targetId: "target-1" });
    await flush();
    expect(observer.response(reattaching)).toBeUndefined();
    const previous = extension;
    extension = wireExtension(bridge);
    sendHello(extension.handlers, defaultTabs());
    await flush();
    const cleanup = previous.socket.frames().find((frame) => frame.method === "Fetch.failRequest")!;
    previous.handlers.onMessage(JSON.stringify({ type: "result", seq: cleanup.seq, result: {} }));
    await flush();
    expect(observer.response(reattaching)).toMatchObject(ownershipError);
    expect(
      extension.socket
        .frames()
        .filter((frame) => frame.type === "detach" || String(frame.method).startsWith("Fetch.")),
    ).toEqual([]);
  });
});
