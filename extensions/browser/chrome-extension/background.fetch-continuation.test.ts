import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import { FakeSocket } from "../src/browser/extension-relay/relay-bridge.test-support.js";
import {
  cleanupBackgroundHarnesses,
  loadRelayCommandHarness,
  sendRuntimeMessage,
} from "./background.test-harness.js";

type Frame = {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
  params?: {
    sessionId?: string;
    requestId?: string;
    targetId?: string;
    targetInfo?: { targetId?: string };
  };
};
type FetchOperation = {
  method: string;
  stage?: "response" | "auth";
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};
const continueRequest: FetchOperation = { method: "Fetch.continueRequest" };
const siblingContinuations: FetchOperation[] = [
  { method: "Fetch.continueResponse", stage: "response" },
  {
    method: "Fetch.continueWithAuth",
    stage: "auth",
    params: { authChallengeResponse: { response: "Default" } },
  },
  { method: "Fetch.failRequest", params: { errorReason: "Aborted" } },
  { method: "Fetch.fulfillRequest", params: { responseCode: 200 } },
];
const bodyReads: FetchOperation[] = [
  {
    method: "Fetch.getResponseBody",
    stage: "response",
    result: { body: "private", base64Encoded: false },
  },
  {
    method: "Fetch.takeResponseBodyAsStream",
    stage: "response",
    result: { stream: "native-body" },
  },
];
const releases = new Set<() => void>();
const cleanups: Array<() => Promise<void>> = [];
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finish = () => {
    releases.delete(finish);
    release();
  };
  releases.add(finish);
  return { promise, resolve: finish };
}

beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const release of releases) {
    release();
  }
  await cleanupBackgroundHarnesses();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.unstubAllGlobals();
});

function connectClient(bridge: ExtensionRelayBridge) {
  const socket = new FakeSocket();
  const handlers = bridge.attachCdpClientSocket(socket);
  const frames = () => socket.frames() as Frame[];
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const requestId = ++id;
    handlers.onMessage(JSON.stringify({ id: requestId, method, params, sessionId }));
    return requestId;
  };
  const response = async (requestId: number) =>
    await vi.waitFor(() => {
      const frame = frames().find((entry) => entry.id === requestId);
      assert(frame, `missing CDP reply ${requestId}`);
      return frame;
    });
  return {
    frames,
    close: handlers.onClose,
    send,
    response,
    request: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      await response(send(method, params, sessionId)),
    root(targetId: string) {
      const attached = frames().find(
        (frame) =>
          frame.method === "Target.attachedToTarget" &&
          frame.params?.targetInfo?.targetId === targetId,
      );
      const sessionId = attached?.params?.sessionId;
      assert(typeof sessionId === "string");
      return sessionId;
    },
  };
}

async function setupTarget(mode: "all" | "selected", operation = continueRequest) {
  const harness = await loadRelayCommandHarness(mode);
  const bridge = new ExtensionRelayBridge();
  const extension = bridge.attachExtensionSocket({
    send: (raw) => harness.socket.receive(JSON.parse(raw)),
    close: () => harness.socket.close(),
  });
  harness.socket.addEventListener("close", extension.onClose);
  const hello = harness.frames().find((frame) => frame.type === "hello");
  assert(hello);
  harness.socket.send.mockImplementation(extension.onMessage);
  extension.onMessage(JSON.stringify(hello));
  const owner = connectClient(bridge);
  const observer = connectClient(bridge);
  cleanups.push(async () => {
    await Promise.all([owner.close(), observer.close()]);
    bridge.dispose();
  });
  for (const client of [owner, observer]) {
    expect(
      await client.request("Target.setAutoAttach", { autoAttach: true, flatten: true }),
    ).toMatchObject({ result: {} });
  }
  const created = await owner.request("Target.createTarget", { url: "about:blank" });
  expect(created).toMatchObject({ result: { targetId: "tab-101" } });
  const targetId = "tab-101";
  const session = owner.root(targetId);
  const observerSession = observer.root(targetId);
  const target = bridge.captureOperationTarget(targetId);
  assert(target);
  return {
    harness,
    bridge,
    owner,
    observer,
    session,
    observerSession,
    target,
    targetId,
    operation,
  };
}

async function setup(mode: "all" | "selected", operation = continueRequest) {
  const rig = await setupTarget(mode, operation);
  const { harness, owner, observer, session, observerSession, target, targetId } = rig;
  expect(await owner.request("Fetch.enable", { handleAuthRequests: true }, session)).toMatchObject({
    result: {},
  });
  const event = operation.stage === "auth" ? "Fetch.authRequired" : "Fetch.requestPaused";
  harness.debuggerEventListener?.({ tabId: 101 }, event, {
    requestId: "native-navigation-request",
    request: { url: "https://example.com/destination", method: "GET", headers: {} },
    frameId: "frame-101",
    resourceType: "Document",
    ...(operation.stage === "response" ? { responseStatusCode: 200 } : {}),
    ...(operation.stage === "auth"
      ? { authChallenge: { origin: "https://example.com", scheme: "basic", realm: "test" } }
      : {}),
  });
  const requestId = owner.frames().findLast((frame) => frame.method === event)?.params?.requestId;
  assert(typeof requestId === "string");
  assert.notEqual(requestId, "native-navigation-request");
  expect(observer.frames().filter((frame) => frame.method === event)).toEqual([]);
  const params: Record<string, unknown> = { ...operation.params, requestId };
  const beforeForeign = harness.debuggerSendCommand.mock.calls.length;
  expect(await observer.request(operation.method, params, observerSession)).toMatchObject({
    error: { message: expect.stringContaining("another session") },
  });
  expect(harness.debuggerSendCommand.mock.calls).toHaveLength(beforeForeign);
  expect(target()).toBe(targetId);
  return { ...rig, params };
}

async function setupConfiguration(mode: "all" | "selected", method: string) {
  const rig = await setupTarget(mode, { method });
  if (method === "Fetch.disable") {
    expect(await rig.owner.request("Fetch.enable", {}, rig.session)).toMatchObject({ result: {} });
  }
  return { ...rig, params: {} };
}

async function holdNativeCompletion(rig: Awaited<ReturnType<typeof setup>>) {
  const started = deferred();
  const completed = deferred();
  const native = rig.harness.debuggerSendCommand.getMockImplementation()!;
  rig.harness.debuggerSendCommand.mockImplementation(async (source, method, params) => {
    if (method !== rig.operation.method) {
      return await native(source, method, params);
    }
    const expectedParams = Object.hasOwn(rig.params, "requestId")
      ? { ...rig.params, requestId: "native-navigation-request" }
      : rig.params;
    expect(params).toEqual(expectedParams);
    started.resolve();
    await completed.promise;
    return rig.operation.result ?? {};
  });
  const id = rig.owner.send(rig.operation.method, rig.params, rig.session);
  await started.promise;
  return { id, complete: completed.resolve };
}

function commitAllowed(rig: Awaited<ReturnType<typeof setup>>) {
  rig.harness.updateTab(101, { url: "https://example.com/destination", pendingUrl: undefined });
  rig.harness.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
    frame: {
      id: "frame-101",
      url: "https://example.com/destination",
      loaderId: "destination-loader",
    },
  });
  rig.harness.debuggerEventListener?.({ tabId: 101 }, "Page.lifecycleEvent", {
    name: "load",
    frameId: "frame-101",
  });
}

function nativeCalls(rig: Awaited<ReturnType<typeof setup>>) {
  return rig.harness.debuggerSendCommand.mock.calls.filter(
    ([, method]) => method === rig.operation.method,
  );
}

async function assertReceiptAndContinuity(rig: Awaited<ReturnType<typeof setup>>, response: Frame) {
  const ownerRead = await rig.owner.request("Page.getFrameTree", {}, rig.session);
  const observerRead = await rig.observer.request("Page.getFrameTree", {}, rig.observerSession);
  expect.soft(response).toMatchObject({ result: {} });
  expect.soft(response.error).toBeUndefined();
  expect.soft(rig.target()).toBe(rig.targetId);
  for (const client of [rig.owner, rig.observer]) {
    expect
      .soft(
        client
          .frames()
          .filter(
            (frame) =>
              frame.method === "Target.detachedFromTarget" &&
              frame.params?.targetId === rig.targetId,
          ),
      )
      .toHaveLength(0);
  }
  expect.soft(ownerRead).toMatchObject({ result: {} });
  expect.soft(observerRead).toMatchObject({ result: {} });
  expect(nativeCalls(rig)).toHaveLength(1);
  expect(rig.bridge.cdpClientCount).toBe(2);
}

// The native completion is the only fault-injected boundary. Real background
// policy, Fetch lease/pause ownership, and both logical relay sessions participate.
describe.each(["all", "selected"] as const)("Fetch continuation in %s", (mode) => {
  it.each(["completion-first", "commit-first"] as const)(
    "preserves receipt and both target sessions: %s",
    async (order) => {
      const rig = await setup(mode);
      const held = await holdNativeCompletion(rig);
      if (order === "commit-first") {
        commitAllowed(rig);
      }
      held.complete();
      const response = await rig.owner.response(held.id);
      if (order === "completion-first") {
        commitAllowed(rig);
      }
      await assertReceiptAndContinuity(rig, response);
    },
  );

  it.each(siblingContinuations)(
    "preserves $method receipt across an allowed document commit",
    async (operation) => {
      const rig = await setup(mode, operation);
      const held = await holdNativeCompletion(rig);
      commitAllowed(rig);
      held.complete();
      await assertReceiptAndContinuity(rig, await rig.owner.response(held.id));
    },
  );

  it.each(
    ["Fetch.enable", "Fetch.disable"].flatMap((method) =>
      ["completion-first", "commit-first"].map((order) => ({ method, order })),
    ),
  )(
    "preserves configuration $method completion ($order) and lease ownership",
    async ({ method, order }) => {
      const rig = await setupConfiguration(mode, method);
      const held = await holdNativeCompletion(rig);
      expect(await rig.observer.request("Fetch.enable", {}, rig.observerSession)).toMatchObject({
        error: { message: expect.stringContaining("another session") },
      });
      expect(nativeCalls(rig)).toHaveLength(1);
      if (order === "commit-first") {
        commitAllowed(rig);
      }
      held.complete();
      const response = await rig.owner.response(held.id);
      if (order === "completion-first") {
        commitAllowed(rig);
      }
      await assertReceiptAndContinuity(rig, response);
      const successor = await rig.observer.request("Fetch.enable", {}, rig.observerSession);
      if (method === "Fetch.disable") {
        expect.soft(successor).toMatchObject({ result: {} });
      } else {
        expect.soft(successor).toMatchObject({
          error: { message: expect.stringContaining("another session") },
        });
        expect(nativeCalls(rig)).toHaveLength(1);
      }
    },
  );

  it.each(["Fetch.enable", "Fetch.disable"])(
    "rejects configuration %s completion after access revocation",
    async (method) => {
      const rig = await setupConfiguration(mode, method);
      const held = await holdNativeCompletion(rig);
      await sendRuntimeMessage(rig.harness, {
        type: "toggleTabAccess",
        tabId: 101,
        accessMode: mode,
        grant: false,
      });
      held.complete();
      const response = await rig.owner.response(held.id);
      expect(response.error).toBeDefined();
      expect(response).not.toHaveProperty("result");
      expect(await rig.owner.request("Page.getFrameTree", {}, rig.session)).toHaveProperty("error");
      expect(nativeCalls(rig)).toHaveLength(1);
    },
  );

  it("rejects disable with an unresolved streamed response without retiring its owner", async () => {
    const operation = bodyReads.find((entry) => entry.method === "Fetch.takeResponseBodyAsStream");
    assert(operation);
    const rig = await setup(mode, operation);
    const held = await holdNativeCompletion(rig);
    held.complete();
    const response = await rig.owner.response(held.id);
    expect(response).toMatchObject({
      result: { stream: expect.stringMatching(/^openclaw-fetch-stream:/) },
    });
    expect(await rig.owner.request("Fetch.disable", {}, rig.session)).toMatchObject({
      error: { message: expect.stringContaining("streamed responses") },
    });
    expect(
      rig.harness.debuggerSendCommand.mock.calls.filter(([, method]) => method === "Fetch.disable"),
    ).toHaveLength(0);
    await assertReceiptAndContinuity(rig, response);
  });

  it.each(bodyReads)("keeps $method data document-sensitive", async (operation) => {
    const rig = await setup(mode, operation);
    const held = await holdNativeCompletion(rig);
    commitAllowed(rig);
    held.complete();
    const response = await rig.owner.response(held.id);
    expect(response.error).toBeDefined();
    expect(response).not.toHaveProperty("result");
    expect(nativeCalls(rig)).toHaveLength(1);
  });

  it.each(["access", "tab-removal", "attachment", "connection"] as const)(
    "rejects completion after genuine %s revocation",
    async (revocation) => {
      const rig = await setup(mode);
      const held = await holdNativeCompletion(rig);
      switch (revocation) {
        case "access":
          await sendRuntimeMessage(rig.harness, {
            type: "toggleTabAccess",
            tabId: 101,
            accessMode: mode,
            grant: false,
          });
          break;
        case "tab-removal":
          await rig.harness.tabsRemove(101);
          break;
        case "attachment":
          rig.harness.debuggerDetachListener?.({ tabId: 101 }, "target_closed");
          break;
        case "connection":
          rig.harness.socket.close();
          break;
      }
      held.complete();
      const response = await rig.owner.response(held.id);
      const successor = await rig.owner.request("Page.getFrameTree", {}, rig.session);
      expect(response.error).toBeDefined();
      expect(response).not.toHaveProperty("result");
      expect(successor.error).toBeDefined();
      expect(nativeCalls(rig)).toHaveLength(1);
    },
  );
});

it("selected-group removal rejects the pending continuation", async () => {
  const rig = await setup("selected");
  const held = await holdNativeCompletion(rig);
  rig.harness.updateTab(101, { groupId: -1 });
  held.complete();
  const response = await rig.owner.response(held.id);
  expect(response.error).toBeDefined();
  expect(response).not.toHaveProperty("result");
  expect(nativeCalls(rig)).toHaveLength(1);
});
