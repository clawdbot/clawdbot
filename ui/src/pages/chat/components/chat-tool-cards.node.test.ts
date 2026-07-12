// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { extractToolCards } from "../../../lib/chat/tool-cards.ts";
import { buildPreviewSidebarContent, buildToolCardSidebarContent } from "./chat-tool-cards.ts";

vi.mock("../../../components/icons.ts", () => ({
  icons: {},
}));

vi.mock("../../../lib/chat/tool-display.ts", () => ({
  formatToolDetail: () => undefined,
  resolveToolDisplay: ({ name }: { name: string }) => ({
    name,
    label:
      {
        sessions_spawn: "Sub-agent",
        skill_workshop: "Skill Workshop",
        web_search: "Web Search",
      }[name] ??
      name
        .split(/[._-]/g)
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
        .join(" "),
    icon: "zap",
  }),
}));

describe("tool-card extraction", () => {
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

  it("does not describe a call-only card as successfully completed", () => {
    const [card] = extractToolCards(
      {
        role: "assistant",
        toolCallId: "call-3",
        content: [
          {
            type: "toolcall",
            name: "deck_manage",
            arguments: "with Example Deck",
          },
        ],
      },
      "msg:3",
    );

    const sidebar = buildToolCardSidebarContent(card);
    expect(sidebar).toBe(`## Deck Manage

**Tool:** \`deck_manage\`

### Tool input
\`\`\`text
with Example Deck
\`\`\`

### Tool output
*No result available.*`);
  });

  it("preserves an empty successful result as completed", () => {
    const [card] = extractToolCards(
      {
        role: "toolResult",
        toolCallId: "call-empty",
        toolName: "deck_manage",
        content: "",
      },
      "msg:empty-success",
    );

    expect(card).toMatchObject({ completed: true });
    expect(card.outputText).toBeUndefined();
    expect(buildToolCardSidebarContent(card)).toContain(
      "*No output — tool completed successfully.*",
    );
  });

  it("builds sidebar content with a failed empty-output status for explicit errors", () => {
    const sidebar = buildToolCardSidebarContent({
      id: "msg:error-empty",
      name: "lookup",
      isError: true,
    });

    expect(sidebar).toBe(`## Lookup

**Tool:** \`lookup\`

### Tool error
*No output — tool failed.*`);
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

    expect(card?.preview?.kind).toBe("canvas");
    expect(card?.preview?.surface).toBe("assistant_message");
    expect(card?.preview?.render).toBe("url");
    expect(card?.preview?.viewId).toBe("cv_inline");
    expect(card?.preview?.url).toBe("/__openclaw__/canvas/documents/cv_inline/index.html");
    expect(card?.preview?.title).toBe("Inline demo");
    expect(card?.preview?.preferredHeight).toBe(420);
    expect(card?.preview?.sandbox).toBe("scripts");
  });

  it("carries the preview sandbox ceiling into sidebar canvas content", () => {
    const sidebar = buildPreviewSidebarContent(
      {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        viewId: "cv_widget",
        url: "/__openclaw__/canvas/documents/cv_widget/index.html",
        title: "Widget",
        sandbox: "scripts",
      },
      null,
    );

    // Dropping the ceiling here would re-grant allow-same-origin to widget
    // script whenever the global embed mode is "trusted".
    expect(sidebar?.kind).toBe("canvas");
    expect(sidebar && "sandbox" in sidebar ? sidebar.sandbox : undefined).toBe("scripts");
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

  it("derives a closed outcome from result presence and error state", async () => {
    const { resolveToolCardOutcome } = await import("../../../lib/chat/tool-cards.ts");
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
});
