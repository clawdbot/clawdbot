/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  buildToolCardSidebarContent,
  extractToolCards,
  renderToolCard,
  renderToolPreview,
} from "./tool-cards.ts";

describe("tool-cards", () => {
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
    expect(cards[0]).toMatchObject({
      id: "msg:1:call-1",
      name: "browser.open",
      outputText: "Opened page",
    });
    expect(cards[0]?.inputText).toContain('"url": "https://example.com"');
    expect(cards[0]?.inputText).toContain('"retry": 0');
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
    expect(cards[0]?.inputText).toContain('"deck": "Example Deck"');
    expect(cards[0]?.inputText).toContain('"mode": "preview"');
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
    expect(cards[0]).toMatchObject({
      inputText: '{\n  "url": "https://example.com/a"\n}',
      outputText: "Opened A",
    });
    expect(cards[1]).toMatchObject({
      inputText: '{\n  "url": "https://example.com/b"\n}',
      outputText: "Opened B",
    });
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
    expect(sidebar).toContain("## Deck Manage");
    expect(sidebar).toContain("### Tool input");
    expect(sidebar).toContain("with Example Deck");
    expect(sidebar).toContain("### Tool output");
    expect(sidebar).toContain("No output");
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

    expect(card?.preview).toMatchObject({
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "cv_inline",
      url: "/__openclaw__/canvas/documents/cv_inline/index.html",
      title: "Inline demo",
      preferredHeight: 420,
    });
  });

  it("drops tool_card-targeted canvas payloads", () => {
    const [card] = extractToolCards(
      {
        role: "tool",
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
      "msg:view:2",
    );

    expect(card?.preview).toBeUndefined();
  });

  it("renders trusted canvas previews with same-origin only when explicitly requested", () => {
    const container = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_inline",
          url: "/__openclaw__/canvas/documents/cv_inline/index.html",
          title: "Inline demo",
          preferredHeight: 420,
        },
        "chat_message",
        { embedSandboxMode: "trusted" },
      ),
      container,
    );

    const iframe = container.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("does not extract inline-html canvas payloads into canvas previews", () => {
    const [card] = extractToolCards(
      {
        role: "tool",
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
      "msg:view:3",
    );

    expect(card?.preview).toBeUndefined();
  });

  it("does not create a view preview for malformed json output", () => {
    const [card] = extractToolCards(
      {
        role: "tool",
        toolName: "canvas_render",
        content: '{"kind":"present_view","view":{"id":"broken"}',
      },
      "msg:view:4",
    );

    expect(card?.preview).toBeUndefined();
  });

  it("does not create a view preview for generic tool text output", () => {
    const [card] = extractToolCards(
      {
        role: "tool",
        toolName: "browser.open",
        content: "present_view: cv_widget",
      },
      "msg:view:5",
    );

    expect(card?.preview).toBeUndefined();
  });

  it("renders expanded cards with inline input and output sections", () => {
    const container = document.createElement("div");
    const toggle = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:4:call-4",
          name: "browser.open",
          args: { url: "https://example.com" },
          inputText: '{\n  "url": "https://example.com"\n}',
          outputText: "Opened page",
        },
        { expanded: true, onToggleExpanded: toggle },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("https://example.com");
    expect(container.textContent).toContain("Opened page");
  });

  it("renders expanded tool calls without an inline output block when no output is present", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:4b:call-4b",
          name: "sessions_spawn",
          args: { mode: "session", thread: true },
          inputText: '{\n  "mode": "session",\n  "thread": true\n}',
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain('"thread": true');
    expect(container.textContent).not.toContain("Tool output");
    expect(container.textContent).not.toContain("No output");
  });

  it("labels collapsed tool calls as tool call", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:5:call-5",
          name: "sessions_spawn",
          args: { mode: "run" },
          inputText: '{\n  "mode": "run"\n}',
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool call");
    expect(container.textContent).not.toContain("Tool input");
    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton).not.toBeNull();
    expect(summaryButton?.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not render inline preview frames inside tool rows anymore", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:view:6",
          name: "canvas_render",
          outputText: JSON.stringify({
            kind: "canvas",
            source: {
              type: "html",
              content: '<div onclick="alert(1)">front<script>window.bad = true;</script></div>',
            },
            presentation: {
              target: "tool_card",
              title: "Status view",
            },
          }),
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            url: "/__openclaw__/canvas/documents/cv_status/index.html",
            title: "Status view",
          },
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const rawToggle = container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle");
    const rawBody = container.querySelector<HTMLElement>(".chat-tool-card__raw-body");

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(rawToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(rawBody?.hidden).toBe(true);

    rawToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(rawToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(rawBody?.hidden).toBe(false);
  });

  it("keeps raw details for legacy canvas tool output without rendering tool-row previews", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:view:7",
          name: "canvas_render",
          outputText: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_counter",
              url: "/__openclaw__/canvas/documents/cv_counter/index.html",
              title: "Counter demo",
              preferred_height: 480,
            },
            presentation: {
              target: "tool_card",
            },
          }),
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_counter",
            title: "Counter demo",
            url: "/__openclaw__/canvas/documents/cv_counter/index.html",
            preferredHeight: 480,
          },
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const rawToggle = container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle");
    const rawBody = container.querySelector<HTMLElement>(".chat-tool-card__raw-body");

    expect(container.textContent).toContain("Counter demo");
    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(rawToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(rawBody?.hidden).toBe(true);

    rawToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(rawToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(rawBody?.hidden).toBe(false);
    expect(rawBody?.textContent).toContain('"kind":"canvas"');
  });

  it("opens assistant-surface canvas payloads in the sidebar when explicitly requested", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:view:8",
          name: "canvas_render",
          outputText: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_sidebar",
              url: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
              title: "Player",
              preferred_height: 360,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_sidebar",
            url: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
            title: "Player",
            preferredHeight: 360,
          },
        },
        { expanded: true, onToggleExpanded: vi.fn(), onOpenSidebar },
      ),
      container,
    );

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");
    sidebarButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(sidebarButton).not.toBeNull();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "canvas",
        docId: "cv_sidebar",
        entryUrl: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
      }),
    );
  });
});
