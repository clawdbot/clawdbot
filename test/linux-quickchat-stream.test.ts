// Exercises the pure stream-assembly helpers extracted from the Linux Quick Chat webview script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { it as test } from "vitest";

const quickchatSource = readFileSync(
  new URL("../apps/linux/ui/quickchat.js", import.meta.url),
  "utf8",
);
const tauriConfig = JSON.parse(
  readFileSync(new URL("../apps/linux/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as {
  app?: {
    security?: {
      capabilities?: Array<{
        identifier?: string;
        windows?: string[];
        webviews?: string[];
      }>;
    };
  };
};
const browserBindingsStart = quickchatSource.indexOf("const tauri = window");
assert.notEqual(browserBindingsStart, -1, "quickchat pure-helper boundary");

type QuickChatHelpers = {
  assembleChatDelta: (state: unknown, payload: unknown) => unknown;
  chatMessageText: (message: unknown) => string;
  chatMessageWidgets: (message: unknown) => unknown[];
  resolveInlineWidgetUrl: (surface: unknown, target: unknown) => string | null;
};

const context: { helpers?: QuickChatHelpers } & Record<string, unknown> = { URL };
vm.runInNewContext(
  `${quickchatSource.slice(0, browserBindingsStart)}\nthis.helpers = { assembleChatDelta, chatMessageText, chatMessageWidgets, resolveInlineWidgetUrl };`,
  context,
);
const { assembleChatDelta, chatMessageText, chatMessageWidgets, resolveInlineWidgetUrl } =
  context.helpers as {
    assembleChatDelta: (state: unknown, payload: unknown) => { text: string; runId?: string };
    chatMessageText: (message: unknown) => string;
    chatMessageWidgets: (message: unknown) => Array<{
      key: string;
      title: string;
      target: string;
      preferredHeight: number;
      sandbox: string;
    }>;
    resolveInlineWidgetUrl: (surface: unknown, target: unknown) => string | null;
  };

function createFakeElement(tagName = "div") {
  const classes = new Set();
  const children: any[] = [];
  return {
    tagName: tagName.toUpperCase(),
    children,
    dataset: {},
    className: "",
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
    src: "",
    title: "",
    referrerPolicy: "",
    contentWindow: tagName === "iframe" ? {} : null,
    addEventListener() {},
    append(...nodes: any[]) {
      children.push(...nodes);
    },
    contains() {
      return false;
    },
    focus() {},
    getBoundingClientRect() {
      return { x: 52, y: 174, width: 540, height: 160 };
    },
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string) {
      return children
        .flatMap((child) => [child, ...(child.querySelectorAll?.(selector) ?? [])])
        .filter((child) =>
          selector.startsWith(".")
            ? child.className.split(/\s+/u).includes(selector.slice(1))
            : child.tagName === selector.toUpperCase(),
        );
    },
    replaceChildren(...nodes: any[]) {
      children.splice(0, children.length, ...nodes);
    },
    setAttribute() {},
  };
}

function createQuickChatHarness(): Record<string, any> {
  const browserBindingsEnd = quickchatSource.indexOf("elements.input.addEventListener");
  assert.notEqual(browserBindingsEnd, -1, "quickchat browser binding boundary");
  const elements = new Map();
  let resolveSend;
  let syncedWidgets: unknown[] = [];
  let syncedHasWidgets = false;
  let syncedExpanded = false;
  let syncedGeneration = 0;
  let widgetSyncCount = 0;
  let widgetSurfaceRefreshCount = 0;
  let widgetSurfaceRefreshResult = "https://gateway.example/__openclaw__/cap/refreshed-capability";
  const sendResult = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const window = {
    __TAURI__: {
      core: {
        invoke(
          method: string,
          args?: {
            widgets?: unknown[];
            hasWidgets?: boolean;
            expanded?: boolean;
            generation?: number;
          },
        ) {
          if (method === "quickchat_send") {
            return sendResult;
          }
          if (method === "quickchat_refresh_widget_surface") {
            widgetSurfaceRefreshCount += 1;
            return Promise.resolve(widgetSurfaceRefreshResult);
          }
          if (method === "quickchat_sync_widgets") {
            syncedWidgets = args?.widgets ?? [];
            syncedHasWidgets = args?.hasWidgets === true;
            syncedExpanded = args?.expanded === true;
            syncedGeneration = args?.generation ?? 0;
            widgetSyncCount += 1;
          }
          return Promise.resolve(null);
        },
      },
      event: { listen: async () => () => {} },
    },
    addEventListener() {},
    clearTimeout() {},
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame(callback: () => void) {
      callback();
    },
    setTimeout: () => 1,
  };
  const document = {
    body: createFakeElement(),
    createElement: (tagName: string) => createFakeElement(tagName),
    createTextNode: (text: string) => ({ textContent: text }),
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        elements.set(selector, createFakeElement());
      }
      return elements.get(selector);
    },
  };
  const browserContext: Record<string, any> = { document, window, URL };
  vm.runInNewContext(
    `${quickchatSource.slice(0, browserBindingsEnd)}
this.harness = {
  send,
  handleChatEvent,
  requestHide,
  clearReply,
  setGatewayUp(surface = "https://gateway.example/__openclaw__/cap/fixture-capability") {
    gatewayState = "up";
    canvasSurfaceUrl = surface;
    canvasSurfaceRefreshedAt = Date.now();
    if (visibilitySequence === 0) visibilitySequence = 1;
  },
  setMessage(value) { elements.input.value = value; },
  pendingCount() { return pendingChatEvents.length; },
  activeRunId() { return activeReply?.runId ?? null; },
  replyText() { return elements.replyText.textContent; },
  expireCanvasSurface() { canvasSurfaceRefreshedAt = 0; },
  flushSurfaceRefresh() { return canvasSurfaceRefreshPromise ?? Promise.resolve(); },
  flushWidgets() { return widgetSyncPromise; },
};`,
    browserContext,
  );
  return {
    ...(browserContext.harness as Record<string, (...args: any[]) => any>),
    resolveSend,
    syncedWidgets: () => syncedWidgets,
    syncedHasWidgets: () => syncedHasWidgets,
    syncedExpanded: () => syncedExpanded,
    syncedGeneration: () => syncedGeneration,
    widgetSyncCount: () => widgetSyncCount,
    widgetSurfaceRefreshCount: () => widgetSurfaceRefreshCount,
    setWidgetSurfaceRefreshResult: (value: string) => {
      widgetSurfaceRefreshResult = value;
    },
  };
}

test("widget child webviews inherit no Quick Chat Tauri capability", () => {
  const capability = tauriConfig.app?.security?.capabilities?.find(
    (candidate) => candidate.identifier === "quickchat",
  );

  assert.deepEqual(capability?.webviews, ["quickchat"]);
  assert.equal(capability?.windows, undefined);
  assert.equal(
    capability?.webviews?.some((label) => label.startsWith("quickchat-widget-")),
    false,
  );
});

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

test("canvas previews are accepted only for safe assistant widgets", () => {
  const [widget] = chatMessageWidgets({
    role: "assistant",
    content: [
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          title: "Build status",
          preferredHeight: 2_000,
          viewId: "build-status",
          url: "/__openclaw__/canvas/documents/build-status/index.html",
        },
      },
    ],
  });

  assert.deepEqual(
    { ...widget },
    {
      key: "build-status",
      title: "Build status",
      target: "/__openclaw__/canvas/documents/build-status/index.html",
      preferredHeight: 1_200,
      sandbox: "scripts",
    },
  );
  const duplicateWidgets = chatMessageWidgets({
    role: "assistant",
    content: [
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: "duplicate",
          url: "/__openclaw__/canvas/documents/first/index.html",
        },
      },
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: "duplicate",
          url: "/__openclaw__/canvas/documents/second/index.html",
        },
      },
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: "duplicate-2",
          url: "/__openclaw__/canvas/documents/third/index.html",
        },
      },
    ],
  });
  assert.equal(duplicateWidgets.length, 3);
  assert.equal(duplicateWidgets[0]?.key, "duplicate");
  assert.equal(duplicateWidgets[1]?.key, "duplicate-2");
  assert.equal(duplicateWidgets[2]?.key, "duplicate-2-2");
  assert.equal(
    new Set(duplicateWidgets.map((candidate) => candidate.key)).size,
    duplicateWidgets.length,
  );
  assert.equal(
    chatMessageWidgets({
      role: "tool",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/tool/index.html",
          },
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    chatMessageWidgets({
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/roleless/index.html",
          },
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    chatMessageWidgets({
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/%252e%252e/private-file",
          },
        },
      ],
    }).length,
    0,
  );
});

test("widget URLs stay inside the capability-scoped Canvas host", () => {
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html?mode=compact#result",
    ),
    "https://gateway.example/base/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/widget-1/index.html?mode=compact#result",
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "http://gateway.example/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    null,
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "http://localhost:18789/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    "http://localhost:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/widget-1/index.html",
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "http://[::1]:18789/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    "http://[::1]:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/widget-1/index.html",
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/fixture-capability?leak=1",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    null,
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/%252f..%252fother",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    null,
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/fixture-capability",
      "https://evil.example/widget.html",
    ),
    null,
  );
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

test("final assistant canvas previews sync into isolated native webviews", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "widget-run" });
  await sending;

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "final",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "strict",
            title: "Status",
            url: "/__openclaw__/canvas/documents/status/index.html",
          },
        },
      ],
    },
  });

  await harness.flushWidgets();
  const [layout] = harness.syncedWidgets();
  assert.deepEqual(
    { ...layout },
    {
      key: "/__openclaw__/canvas/documents/status/index.html",
      url: "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html",
      sandbox: "strict",
      x: 52,
      y: 174,
      width: 540,
      height: 160,
      visible: true,
    },
  );
  assert.equal(harness.syncedHasWidgets(), true);
  assert.equal(harness.syncedExpanded(), true);
  assert.equal(harness.syncedGeneration(), 1);
});

test("expired Canvas capability refreshes before a new widget loads", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.expireCanvasSurface();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "refresh-run" });
  await sending;
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "refresh-run",
    state: "final",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/status/index.html",
          },
        },
      ],
    },
  });

  await harness.flushSurfaceRefresh();
  await harness.flushWidgets();
  assert.equal(harness.widgetSurfaceRefreshCount(), 1);
  assert.equal(
    harness.syncedWidgets()[0]?.url,
    "https://gateway.example/__openclaw__/cap/refreshed-capability/__openclaw__/canvas/documents/status/index.html",
  );
});

test("clearing the widget reply restores semantic text-only layout", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "widget-run" });
  await sending;
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/status/index.html",
          },
        },
      ],
    },
  });
  await harness.flushWidgets();
  assert.equal(harness.syncedHasWidgets(), true);

  harness.clearReply();
  await harness.flushWidgets();
  assert.equal(harness.syncedHasWidgets(), false);
  assert.equal(harness.syncedExpanded(), false);
  assert.deepEqual([...harness.syncedWidgets()], []);
});

test("adding a widget preserves the existing native webview identity", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "widget-run" });
  await sending;
  const widgetBlock = (id: string) => ({
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      sandbox: "scripts",
      title: id,
      viewId: id,
      url: `/__openclaw__/canvas/documents/${id}/index.html`,
    },
  });

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    message: { role: "assistant", content: [widgetBlock("first")] },
  });
  await harness.flushWidgets();
  const firstLayout = { ...harness.syncedWidgets()[0] };
  const syncCountBeforeText = harness.widgetSyncCount();
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    deltaText: "status update",
  });
  await harness.flushWidgets();
  assert.ok(harness.widgetSyncCount() > syncCountBeforeText);

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    message: { role: "assistant", content: [widgetBlock("first"), widgetBlock("second")] },
  });
  await harness.flushWidgets();
  const layouts = harness.syncedWidgets().map((layout: object) => ({ ...layout }));

  assert.deepEqual(layouts[0], firstLayout);
  assert.equal(layouts[0].visible, true);
  assert.equal(layouts[1].key, "second");
  assert.equal(layouts[1].visible, false);
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
