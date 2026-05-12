// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { buildToolCardSidebarContent, extractToolCards } from "./tool-cards.ts";

vi.mock("../icons.ts", () => ({
  icons: {},
}));

vi.mock("../tool-display.ts", () => ({
  formatToolDetail: () => undefined,
  resolveToolDisplay: ({ name }: { name: string }) => ({
    name,
    label: name
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

  it("builds sidebar content with input and empty output status", () => {
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
*No output — tool completed successfully.*`);
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
