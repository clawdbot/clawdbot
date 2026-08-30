// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractToolCardsCached as extractToolCards,
  isToolCardError,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import * as toolDisplay from "../../../lib/chat/tool-display.ts";

function resolveToolDisplay({ name = "" }: Parameters<typeof toolDisplay.resolveToolDisplay>[0]) {
  return {
    name,
    label:
      {
        sessions_spawn: "Sub-agent",
        skill_workshop: "Skill Workshop",
        web_search: "Web Search",
      }[name] ??
      name
        .split(/[._-]/g)
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join(" "),
    icon: "zap",
  } as ReturnType<typeof toolDisplay.resolveToolDisplay>;
}

beforeEach(() => {
  vi.spyOn(toolDisplay, "formatToolDetail").mockReturnValue(undefined);
  vi.spyOn(toolDisplay, "resolveToolDisplay").mockImplementation(resolveToolDisplay);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool-card extraction", () => {
  const browserDetails = {
    browserTab: { profile: "managed", target: "host", targetId: "tab-origin" },
  };

  it.each(["read", "browser.open", "mcp__other__browser", undefined])(
    "keeps browser-shaped results from %s as ordinary tool cards",
    (name) => {
      for (const message of [
        { role: "toolResult", toolName: name, details: browserDetails, content: "ordinary output" },
        {
          role: "assistant",
          content: [
            { type: "tool_result", name, text: "ordinary output", details: browserDetails },
          ],
        },
        {
          role: "assistant",
          toolCallId: "live-origin",
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: true,
          content: [
            { type: "toolcall", name, arguments: {} },
            { type: "toolresult", name, text: "ordinary output", details: browserDetails },
          ],
        },
      ]) {
        const cards = extractToolCards(message);
        expect(cards).toHaveLength(1);
        expect(cards[0]?.outputText).toBe("ordinary output");
        expect(cards[0]?.preview).toBeUndefined();
      }
    },
  );

  it.each([
    ["browser", undefined, true],
    ["browser", "read", true],
    ["read", "browser", false],
    [undefined, "browser", false],
  ] as const)(
    "uses the paired call origin %s instead of the result name %s",
    (callName, resultName, browserOrigin) => {
      const cards = extractToolCards({
        role: "assistant",
        content: [
          { type: "toolcall", id: "origin-call", name: callName, arguments: {} },
          {
            type: "tool_result",
            tool_use_id: "origin-call",
            name: resultName,
            text: "paired output",
            details: browserDetails,
          },
        ],
      });
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ name: callName ?? "tool", outputText: "paired output" });
      expect(cards[0]?.preview).toEqual(
        browserOrigin ? { kind: "browser-tab", ...browserDetails.browserTab } : undefined,
      );
    },
  );

  it("does not borrow browser origin from a call with a different ID", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        { type: "toolcall", id: "browser-call", name: "browser", arguments: {} },
        {
          type: "tool_result",
          id: "unknown-call",
          text: "unpaired output",
          details: browserDetails,
        },
      ],
    });
    expect(cards).toHaveLength(2);
    expect(cards[1]?.outputText).toBe("unpaired output");
    expect(cards[1]?.preview).toBeUndefined();
  });

  it.each(["read", "browser.open", "mcp__other__browser", undefined])(
    "does not let nested content claim browser origin inside a %s tool envelope",
    (toolName) => {
      for (const nameField of ["toolName", "tool_name"]) {
        const [card] = extractToolCards({
          role: "toolResult",
          [nameField]: toolName,
          content: [
            {
              type: "tool_result",
              name: "browser",
              text: "nested output",
              details: browserDetails,
            },
          ],
        });
        expect(card?.name).toBe("browser");
        expect(card?.outputText).toBe("nested output");
        expect(card?.preview).toBeUndefined();
        const [paired] = extractToolCards({
          role: "toolResult",
          [nameField]: toolName,
          content: [
            { type: "toolcall", id: "nested-browser", name: "browser", arguments: {} },
            {
              type: "tool_result",
              id: "nested-browser",
              name: "browser",
              text: "nested paired output",
              details: browserDetails,
            },
          ],
        });
        expect(paired?.outputText).toBe("nested paired output");
        expect(paired?.preview).toBeUndefined();
      }
    },
  );

  it.each(["toolName", "tool_name"])("retains browser envelope origin from %s", (nameField) => {
    const [card] = extractToolCards({
      role: "toolResult",
      [nameField]: "browser",
      content: [{ type: "tool_result", text: "browser output", details: browserDetails }],
    });
    expect(card?.preview).toEqual({ kind: "browser-tab", ...browserDetails.browserTab });
    expect(card?.outputText).toBe("browser output");
  });

  it.each(["standalone", "block", "live"])("extracts browser tabs from %s results", (shape) => {
    const details = {
      browserTab: {
        profile: "managed",
        target: "host",
        targetId: "tab-1",
        url: "https://example.com",
        title: "Example",
        extra: "drop",
      },
    };
    const result = { type: "toolresult", id: "call-browser", name: "browser", text: "ok" };
    const message =
      shape === "standalone"
        ? { role: "toolResult", toolName: "browser", details, content: "ok" }
        : {
            role: "assistant",
            details,
            ...(shape === "live"
              ? {
                  __openclawToolStreamLive: true,
                  __openclawToolStreamResultReceived: true,
                }
              : {}),
            content: [
              { type: "toolcall", id: "call-browser", name: "browser", arguments: {} },
              { ...result, ...(shape === "block" ? { details } : {}) },
            ],
          };
    const [card] = extractToolCards(message);
    expect(card?.preview).toEqual({
      kind: "browser-tab",
      profile: "managed",
      target: "host",
      targetId: "tab-1",
      url: "https://example.com",
      title: "Example",
    });
    expect(card?.completed).toBe(true);
  });

  it.each([
    null,
    [],
    "tab",
    {},
    { targetId: 3 },
    { targetId: " " },
    { targetId: "t1" },
    { targetId: "t1", profile: "managed" },
    { targetId: "t1", profile: "managed", target: "node" },
    { targetId: "t1", profile: "managed", target: "host", node: "node-a" },
    { targetId: "t1", profile: "managed", target: "sandbox" },
    { targetId: "t".repeat(129), profile: "managed", target: "host" },
    { targetId: "t1", profile: "p".repeat(129), target: "host" },
    { targetId: "t1", profile: "managed", target: "node", node: "n".repeat(257) },
  ])("ignores malformed browser tabs (%j)", (browserTab) => {
    expect(
      extractToolCards({ role: "tool", toolName: "browser", details: { browserTab } })[0]?.preview,
    ).toBeUndefined();
  });

  it("retains exact bounded node identities without provider metadata", () => {
    const browserTab = {
      targetId: "t".repeat(128),
      profile: "p".repeat(128),
      target: "node",
      node: "n".repeat(256),
    };
    const [card] = extractToolCards({
      role: "toolResult",
      toolName: "browser",
      details: {
        browserTab: {
          ...browserTab,
          cdpUrl: "https://private.example/",
          token: "not-a-real-token",
        },
      },
    });
    expect(card?.preview).toEqual({ kind: "browser-tab", ...browserTab });
  });

  it("drops non-string browser metadata and gives canvas previews precedence", () => {
    const browserTab = {
      profile: "managed",
      target: "host",
      targetId: "tab-1",
      url: 42,
      title: [],
    };
    expect(
      extractToolCards({ role: "tool", toolName: "browser", details: { browserTab } })[0]?.preview,
    ).toEqual({
      kind: "browser-tab",
      profile: "managed",
      target: "host",
      targetId: "tab-1",
    });
    const canvas = {
      kind: "canvas",
      view: { id: "cv_app" },
      presentation: { target: "assistant_message" },
      mcpApp: { viewId: "cv_app" },
    };
    for (const message of [
      { role: "tool", details: { browserTab, mcpAppPreview: canvas } },
      { role: "tool", toolName: "browser", details: { browserTab, mcpAppPreview: canvas } },
      {
        role: "tool",
        toolName: "canvas_render",
        details: { browserTab },
        content: JSON.stringify(canvas),
      },
    ]) {
      expect(extractToolCards(message)[0]?.preview?.kind).toBe("canvas");
    }
  });

  it("pretty-prints structured args and pairs tool output onto the same card", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        toolCallId: "call-1",
        content: [
          {
            type: "toolcall",
            id: "call-1",
            name: "browser.open",
            arguments: { url: "https://example.com", retry: 0 },
          },
          {
            type: "toolresult",
            id: "call-1",
            name: "browser.open",
            text: "Opened page",
          },
        ],
      },
      "msg:1",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("msg:1:call-1");
    expect(cards[0]?.name).toBe("browser.open");
    expect(cards[0]?.completed).toBe(true);
    expect(cards[0]?.outputText).toBe("Opened page");
    expect(cards[0]?.inputText).toBe(`{
  "url": "https://example.com",
  "retry": 0
}`);
  });

  it("never exposes redacted tool arguments to any card renderer", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        toolCallId: "call-publish",
        content: [
          {
            type: "toolcall",
            id: "call-publish",
            name: "delegate_artifacts_publish",
            arguments: { paths: ["reports/private-quarterly-summary.pdf", "notes/secret.md"] },
            details: { path: "reports/private-quarterly-summary.pdf" },
          },
        ],
      },
      "msg:redact",
    );

    expect(cards).toHaveLength(1);
    // `args` feeds the key-value list and the collapsed preview; `inputText`
    // feeds the sidebar and the expanded raw block. Neither may carry paths.
    expect(cards[0]?.args).toBeUndefined();
    expect(cards[0]?.inputText).toBe("artifact paths redacted");
    expect(cards[0]?.details).toBeUndefined();
    expect(JSON.stringify(cards[0])).not.toContain("private-quarterly-summary");
    expect(JSON.stringify(cards[0])).not.toContain("secret.md");
  });

  it("preserves string args verbatim and keeps empty-output cards", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        toolCallId: "call-2",
        content: [
          {
            type: "toolcall",
            name: "deck_manage",
            arguments: "with Example Deck",
          },
        ],
      },
      "msg:2",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.inputText).toBe("with Example Deck");
    expect(cards[0]?.completed).toBeUndefined();
    expect(cards[0]?.outputText).toBeUndefined();
  });

  it("preserves tool-call input payloads from tool_use blocks", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-2b",
            name: "deck_manage",
            input: { deck: "Example Deck", mode: "preview" },
          },
        ],
      },
      "msg:2b",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.inputText).toBe(`{
  "deck": "Example Deck",
  "mode": "preview"
}`);
  });

  it("preserves legacy callId tool block identities", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            callId: "legacy-call-id",
            name: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      "legacy-call",
    );

    expect(cards[0]?.callId).toBe("legacy-call-id");
    expect(cards[0]?.id).toBe("legacy-call:legacy-call-id");
  });

  it("pairs interleaved nameless tool results in content order", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "browser.open",
            input: { url: "https://example.com/a" },
          },
          {
            type: "tool_result",
            name: "browser.open",
            text: "Opened A",
          },
          {
            type: "tool_use",
            name: "browser.open",
            input: { url: "https://example.com/b" },
          },
          {
            type: "tool_result",
            name: "browser.open",
            text: "Opened B",
          },
        ],
      },
      "msg:ordered",
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]?.inputText).toBe('{\n  "url": "https://example.com/a"\n}');
    expect(cards[0]?.outputText).toBe("Opened A");
    expect(cards[1]?.inputText).toBe('{\n  "url": "https://example.com/b"\n}');
    expect(cards[1]?.outputText).toBe("Opened B");
  });

  it("pairs sequential nameless same-name tool results with the earliest unmatched call", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { path: "a.txt" },
          },
          {
            type: "tool_use",
            name: "read",
            input: { path: "b.txt" },
          },
          {
            type: "tool_result",
            name: "read",
            text: "A contents",
          },
          {
            type: "tool_result",
            name: "read",
            text: "B contents",
          },
        ],
      },
      "msg:sequential",
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]?.inputText).toBe('{\n  "path": "a.txt"\n}');
    expect(cards[0]?.outputText).toBe("A contents");
    expect(cards[1]?.inputText).toBe('{\n  "path": "b.txt"\n}');
    expect(cards[1]?.outputText).toBe("B contents");
  });

  it.each([
    ["canonical IDs", { id: "call-b" }],
    ["snake-case tool-call IDs", { tool_call_id: "call-b" }],
    ["camel-case tool-call IDs", { toolCallId: "call-b" }],
    ["provider tool-use IDs", { tool_use_id: "call-b" }],
    ["camel-case tool-use IDs", { toolUseId: "call-b" }],
    ["legacy call IDs", { callId: "call-b" }],
  ])(
    "keeps a same-name result with different %s separate from an open call",
    (_label, resultId) => {
      const cards = extractToolCards(
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-a",
              name: "read",
              input: { path: "a.txt" },
            },
            {
              type: "tool_result",
              ...resultId,
              name: "read",
              text: "B failed",
              isError: true,
            },
          ],
        },
        "msg:separate-owners",
      );

      expect(cards).toHaveLength(2);
      expect(cards[0]).toMatchObject({ callId: "call-a", name: "read" });
      expect(cards[0]?.completed).toBeUndefined();
      expect(cards[0]?.outputText).toBeUndefined();
      expect(cards[0]?.isError).toBeUndefined();
      expect(cards[1]).toMatchObject({
        callId: "call-b",
        name: "read",
        completed: true,
        outputText: "B failed",
        isError: true,
      });
    },
  );

  it.each([
    ["only the call owns an ID", { id: "call-a" }, {}],
    ["only the result owns an ID", {}, { tool_use_id: "call-b" }],
  ])("preserves legacy same-name fallback when %s", (_label, callId, resultId) => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            ...callId,
            name: "read",
            input: { path: "legacy.txt" },
          },
          {
            type: "tool_result",
            ...resultId,
            name: "read",
            text: "Legacy contents",
          },
        ],
      },
      "msg:legacy-owner",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      name: "read",
      completed: true,
      outputText: "Legacy contents",
    });
  });

  it("does not reuse nameless same-name calls after an empty result", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { path: "empty.txt" },
          },
          {
            type: "tool_use",
            name: "read",
            input: { path: "next.txt" },
          },
          {
            type: "tool_result",
            name: "read",
            text: "",
          },
          {
            type: "tool_result",
            name: "read",
            text: "Next contents",
          },
        ],
      },
      "msg:empty-result",
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]?.inputText).toBe('{\n  "path": "empty.txt"\n}');
    expect(cards[0]?.completed).toBe(true);
    expect(cards[0]?.outputText).toBe("");
    expect(cards[1]?.inputText).toBe('{\n  "path": "next.txt"\n}');
    expect(cards[1]?.outputText).toBe("Next contents");
  });

  it("extracts tool result output from text block content arrays", () => {
    const cards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "toolcall",
            id: "call-read",
            name: "read",
            input: { path: "README.md" },
          },
          {
            type: "tool_result",
            id: "call-read",
            name: "read",
            content: [
              { type: "text", text: "# Heading" },
              { type: "text", text: "file body" },
            ],
          },
        ],
      },
      "msg:read",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.outputText).toBe("# Heading\nfile body");
  });

  it("preserves explicit tool error flags from tool result items and messages", () => {
    const pairedCards = extractToolCards(
      {
        role: "assistant",
        content: [
          {
            type: "toolcall",
            id: "call-error",
            name: "lookup",
          },
          {
            type: "tool_result",
            id: "call-error",
            name: "lookup",
            text: "lookup failed",
            isError: true,
          },
        ],
      },
      "msg:error-item",
    );

    expect(pairedCards[0]?.isError).toBe(true);

    const messageFlagCards = extractToolCards(
      {
        role: "toolResult",
        isError: true,
        content: [
          {
            type: "tool_result",
            id: "call-message-error",
            name: "lookup",
            text: "lookup failed",
          },
        ],
      },
      "msg:error-message-flag",
    );

    expect(messageFlagCards[0]?.isError).toBe(true);

    const standaloneCards = extractToolCards(
      {
        role: "tool",
        toolName: "lookup",
        content: "lookup failed",
        isError: true,
      },
      "msg:error-message",
    );

    expect(standaloneCards[0]?.isError).toBe(true);
  });

  it("extracts canvas handle payloads into canvas previews", () => {
    const [card] = extractToolCards(
      {
        role: "tool",
        toolName: "canvas_render",
        content: JSON.stringify({
          kind: "canvas",
          view: {
            backend: "canvas",
            id: "cv_inline",
            url: "/__openclaw__/canvas/documents/cv_inline/index.html",
          },
          presentation: {
            target: "assistant_message",
            title: "Inline demo",
            preferred_height: 420,
            sandbox: "scripts",
          },
        }),
      },
      "msg:view:1",
    );

    expect(card?.preview).toMatchObject({
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "cv_inline",
      url: "/__openclaw__/canvas/documents/cv_inline/index.html",
      title: "Inline demo",
      preferredHeight: 420,
      sandbox: "scripts",
    });
  });

  it("uses transcript metadata ids for history-backed tool messages", () => {
    const [card] = extractToolCards(
      {
        role: "tool",
        toolName: "browser.open",
        content: [{ type: "text", text: "Opened page" }],
        __openclaw: { id: "msg-tool-history-1", seq: 7 },
      },
      "msg:history",
    );

    expect(card?.messageId).toBe("msg-tool-history-1");
    expect(card?.outputText).toBe("Opened page");
  });

  it("extracts MCP App previews from sanitized result details", () => {
    const [card] = extractToolCards(
      {
        role: "tool",
        toolName: "demo__show",
        content: [{ type: "text", text: "original result" }],
        details: {
          mcpAppPreview: {
            kind: "canvas",
            view: {
              id: "cv_app",
            },
            presentation: { target: "assistant_message", sandbox: "scripts" },
            mcpApp: { viewId: "cv_app" },
          },
        },
      },
      "msg:mcp-app",
    );

    expect(card?.outputText).toBe("original result");
    expect(card?.preview).toMatchObject({
      viewId: "cv_app",
      mcpApp: { viewId: "cv_app" },
      sandbox: "scripts",
    });
  });

  it("does not create previews for non-assistant canvas or generic outputs", () => {
    const cases = [
      {
        name: "node-panel target",
        toolName: "show_widget",
        content: JSON.stringify({
          kind: "canvas",
          view: {
            id: "cv_node_panel",
            url: "/__openclaw__/canvas/documents/cv_node_panel/index.html",
          },
          presentation: {
            target: "node_panel",
            title: "Device panel demo",
          },
        }),
      },
      {
        name: "tool-card target",
        toolName: "canvas_render",
        content: JSON.stringify({
          kind: "canvas",
          view: {
            backend: "canvas",
            id: "cv_tool_card",
            url: "/__openclaw__/canvas/documents/cv_tool_card/index.html",
          },
          presentation: {
            target: "tool_card",
            title: "Tool card demo",
          },
        }),
      },
      {
        name: "inline html",
        toolName: "canvas_render",
        content: JSON.stringify({
          kind: "canvas",
          source: {
            type: "html",
            content: "<div>hello</div>",
          },
          presentation: {
            target: "assistant_message",
            title: "Status",
            preferred_height: 300,
          },
        }),
      },
      {
        name: "malformed json",
        toolName: "canvas_render",
        content: '{"kind":"present_view","view":{"id":"broken"}',
      },
      {
        name: "generic text",
        toolName: "browser.open",
        content: "present_view: cv_widget",
      },
    ] as const;

    for (const testCase of cases) {
      const [card] = extractToolCards(
        {
          role: "tool",
          toolName: testCase.toolName,
          content: testCase.content,
        },
        `msg:view:${testCase.name}`,
      );

      expect(card?.preview, testCase.name).toBeUndefined();
    }
  });
});

describe("tool-card canvas URLs", () => {
  async function loadResolver() {
    return vi.importActual<typeof import("../../../lib/chat/tool-display.ts")>(
      "../../../lib/chat/tool-display.ts",
    );
  }

  it("accepts hosted canvas paths and scopes them through the canvas capability host", async () => {
    const { resolveCanvasIframeUrl } = await loadResolver();

    expect(resolveCanvasIframeUrl("/__openclaw__/canvas/documents/cv_demo/index.html")).toBe(
      "/__openclaw__/canvas/documents/cv_demo/index.html",
    );
    expect(
      resolveCanvasIframeUrl(
        "/__openclaw__/canvas/documents/cv_demo/index.html",
        "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
      ),
    ).toBe(
      "http://127.0.0.1:19003/__openclaw__/cap/cap_123/__openclaw__/canvas/documents/cv_demo/index.html",
    );
  });

  it("rejects unsafe canvas frame URLs unless external embeds are explicitly enabled", async () => {
    const { resolveCanvasIframeUrl } = await loadResolver();

    expect(resolveCanvasIframeUrl("/not-canvas/snake.html")).toBeUndefined();
    expect(resolveCanvasIframeUrl("https://example.com/evil.html")).toBeUndefined();
    expect(resolveCanvasIframeUrl("file:///tmp/snake.html")).toBeUndefined();
    expect(resolveCanvasIframeUrl("https://example.com/embed.html?x=1#y", undefined, true)).toBe(
      "https://example.com/embed.html?x=1#y",
    );
  });
});

describe("isRunningToolCard", () => {
  it("marks only live uncompleted cards as running while a run is active", async () => {
    const { isRunningToolCard } = await import("./chat-tool-cards.ts");
    const liveCard = { id: "t:1", name: "bash", live: true } as const;
    const historicalCard = { id: "t:2", name: "bash" } as const;

    expect(isRunningToolCard(liveCard, true)).toBe(true);
    // Partial streamed output must not end the running state; only the final
    // result event does.
    expect(isRunningToolCard({ ...liveCard, outputText: "partial…" }, true)).toBe(true);
    expect(isRunningToolCard({ ...liveCard, completed: true, outputText: "" }, true)).toBe(false);
    // Historical transcript calls without results (e.g. aborted runs) must
    // stay inert when a later run is active in the same session.
    expect(isRunningToolCard(historicalCard, true)).toBe(false);
    expect(isRunningToolCard(liveCard, false)).toBe(false);
  });

  it("derives a closed outcome from result presence and error state", () => {
    const call = { id: "t:call", name: "edit" } as const;

    expect(resolveToolCardOutcome(call, false)).toBe("unknown");
    expect(resolveToolCardOutcome({ ...call, live: true }, true)).toBe("running");
    expect(resolveToolCardOutcome({ ...call, completed: true, outputText: "" }, false)).toBe(
      "succeeded",
    );
    expect(resolveToolCardOutcome({ ...call, completed: true, isError: true }, false)).toBe(
      "failed",
    );
  });

  it("threads live and completion markers from tool-stream messages into cards", () => {
    const running = extractToolCards({
      role: "assistant",
      toolCallId: "call-live",
      __openclawToolStreamLive: true,
      __openclawToolStreamResultReceived: false,
      content: [{ type: "toolcall", name: "bash", arguments: { command: "sleep 5" } }],
    });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ live: true, completed: false });

    const finished = extractToolCards({
      role: "assistant",
      toolCallId: "call-live",
      __openclawToolStreamLive: true,
      __openclawToolStreamResultReceived: true,
      content: [{ type: "toolcall", name: "bash", arguments: { command: "sleep 5" } }],
    });
    expect(finished[0]).toMatchObject({ live: true, completed: true });
  });

  it.each(['{"error": "partial text"}', '{"status":"failed"}', "Tool not found", "partial text"])(
    "keeps partial output %s nonterminal until the live result arrives",
    (text) => {
      // The stream emits toolresult blocks for partial `update` output; only
      // resultReceived may complete a live card, or a running tool flips to
      // "succeeded" (or "failed", if the partial text looks like an error).
      const partial = extractToolCards({
        role: "assistant",
        toolCallId: "call-live",
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: false,
        content: [
          { type: "toolcall", name: "bash", arguments: { command: "sleep 5" } },
          { type: "toolresult", name: "bash", text },
        ],
      });
      expect(partial).toHaveLength(1);
      expect(partial[0]).toMatchObject({ live: true, completed: false });
      expect(partial[0]?.outputText).toBe(text);
      expect(partial.map(isToolCardError)).toEqual([false]);
      expect(partial.map((card) => resolveToolCardOutcome(card, true))).toEqual(["running"]);
      expect(partial.map((card) => resolveToolCardOutcome(card, false))).toEqual(["unknown"]);

      const done = extractToolCards({
        role: "assistant",
        toolCallId: "call-live",
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: true,
        content: [
          { type: "toolcall", name: "bash", arguments: { command: "sleep 5" } },
          { type: "toolresult", name: "bash", text: "ok" },
        ],
      });
      expect(done[0]).toMatchObject({ live: true, completed: true });
      expect(done.map((card) => resolveToolCardOutcome(card, true))).toEqual(["succeeded"]);
    },
  );
});
