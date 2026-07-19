// Exercises the pure stream-assembly helpers extracted from the Linux Quick Chat webview script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { it as test } from "vitest";

const quickchatSource = readFileSync(
  new URL("../apps/linux/ui/quickchat.js", import.meta.url),
  "utf8",
);
const browserBindingsStart = quickchatSource.indexOf("const tauri = window");
assert.notEqual(browserBindingsStart, -1, "quickchat pure-helper boundary");

const context: Record<
  string,
  {
    assembleChatDelta: (state: unknown, payload: unknown) => unknown;
    chatMessageText: (message: unknown) => string;
  }
> &
  Record<string, unknown> = {};
vm.runInNewContext(
  `${quickchatSource.slice(0, browserBindingsStart)}\nthis.helpers = { assembleChatDelta, chatMessageText };`,
  context,
);
const { assembleChatDelta, chatMessageText } = context.helpers as {
  assembleChatDelta: (state: unknown, payload: unknown) => { text: string; runId?: string };
  chatMessageText: (message: unknown) => string;
};

function createFakeElement() {
  const classes = new Set();
  return {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      toggle(name: string, force?: boolean) {
        const enabled = force ?? !classes.has(name);
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return enabled;
      },
    },
    style: { setProperty() {} },
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    readOnly: false,
    scrollHeight: 0,
    scrollTop: 0,
    addEventListener() {},
    contains() {
      return false;
    },
    focus() {},
    querySelectorAll() {
      return [];
    },
    replaceChildren() {},
    setAttribute() {},
  };
}

function createQuickChatHarness(): Record<string, any> {
  const browserBindingsEnd = quickchatSource.indexOf("elements.input.addEventListener");
  assert.notEqual(browserBindingsEnd, -1, "quickchat browser binding boundary");
  const elements = new Map();
  let resolveSend;
  const sendResult = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const window = {
    __TAURI__: {
      core: {
        invoke(method: string) {
          return method === "quickchat_send" ? sendResult : Promise.resolve(null);
        },
      },
      event: { listen: async () => () => {} },
    },
    clearTimeout() {},
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame(callback: () => void) {
      callback();
    },
    setTimeout: () => 1,
  };
  const document = {
    body: createFakeElement(),
    createElement: () => createFakeElement(),
    createTextNode: (text: string) => ({ textContent: text }),
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        elements.set(selector, createFakeElement());
      }
      return elements.get(selector);
    },
  };
  const browserContext: Record<string, any> = { document, window };
  vm.runInNewContext(
    `${quickchatSource.slice(0, browserBindingsEnd)}
this.harness = {
  send,
  handleChatEvent,
  requestHide,
  setGatewayUp() { gatewayState = "up"; },
  setMessage(value) { elements.input.value = value; },
  pendingCount() { return pendingChatEvents.length; },
  activeRunId() { return activeReply?.runId ?? null; },
  replyText() { return elements.replyText.textContent; },
};`,
    browserContext,
  );
  return { ...(browserContext.harness as Record<string, (...args: any[]) => any>), resolveSend };
}

test("replace deltas are authoritative", () => {
  assert.equal(
    assembleChatDelta("stale", {
      deltaText: "replacement",
      replace: true,
      message: { content: [{ type: "text", text: "ignored snapshot" }] },
    }),
    "replacement",
  );
});

test("the first delta seeds from its message snapshot", () => {
  assert.equal(
    assembleChatDelta(null, {
      deltaText: "lo",
      message: { content: [{ type: "text", text: "Hello" }] },
    }),
    "Hello",
  );
  assert.equal(assembleChatDelta(null, { deltaText: "Hi" }), "Hi");
});

test("matching deltas append and mismatched snapshots self-heal", () => {
  assert.equal(
    assembleChatDelta("Hello", {
      deltaText: "!",
      message: { content: [{ type: "text", text: "Hello!" }] },
    }),
    "Hello!",
  );
  assert.equal(
    assembleChatDelta("Hellx", {
      deltaText: "!",
      message: { content: [{ type: "text", text: "Hello!" }] },
    }),
    "Hello!",
  );
});

test("snapshot-only terminal frames replace the assembled text", () => {
  assert.equal(
    assembleChatDelta("partial", {
      message: { content: [{ type: "text", text: "complete" }] },
    }),
    "complete",
  );
});

test("snapshot extraction joins every text block", () => {
  assert.equal(
    chatMessageText({
      content: [
        { type: "text", text: "first" },
        { type: "image", url: "data:image/png;base64,AA==" },
        { type: "text", text: "second" },
      ],
    }),
    "first\n\nsecond",
  );
});

test("snapshot extraction skips a leading non-text block", () => {
  assert.equal(
    chatMessageText({
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible" },
      ],
    }),
    "visible",
  );
});

test("snapshot extraction falls back through string content and top-level text", () => {
  assert.equal(chatMessageText({ content: "string content", text: "top-level" }), "string content");
  assert.equal(chatMessageText({ content: [], text: "top-level" }), "top-level");
});

test("pre-ack frames replay once for only the acknowledged run", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("hello");
  const sending = harness.send(false);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "wrong-run",
    state: "delta",
    deltaText: "wrong",
  });
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "right-run",
    state: "delta",
    deltaText: "right",
  });
  assert.equal(harness.pendingCount(), 2);

  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "right-run" });
  await sending;

  assert.equal(harness.pendingCount(), 0);
  assert.equal(harness.activeRunId(), "right-run");
  assert.equal(harness.replyText(), "right");

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: " right-run ",
    state: "delta",
    deltaText: " whitespace-id",
  });
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "other-agent",
    runId: "right-run",
    state: "delta",
    deltaText: " wrong-agent",
  });
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "right-run",
    state: "delta",
    deltaText: "!",
  });
  assert.equal(harness.replyText(), "right!");
});

test("hiding clears buffered pre-ack frames", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("hello");
  const sending = harness.send(false);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "right-run",
    state: "delta",
    deltaText: "buffered",
  });
  assert.equal(harness.pendingCount(), 1);

  await harness.requestHide();
  assert.equal(harness.pendingCount(), 0);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "right-run" });
  await sending;
  assert.equal(harness.replyText(), "");
});
