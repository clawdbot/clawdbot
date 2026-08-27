/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

// Keep these as literal source text: parsing expected values would repeat the
// rounding and duplicate-key loss that the display must not introduce.
const jsonSources = [
  {
    name: "object numeric lexemes",
    text: '{"id":9007199254740993,"overflow":1e400,"decimal":0.1234567890123456789,"zero":-0}',
  },
  {
    name: "array numeric lexemes",
    text: "[9007199254740993,1e400,0.1234567890123456789,-0]",
  },
  { name: "duplicate keys", text: '{"state":"before","state":"after"}' },
  {
    name: "escaped strings",
    text: String.raw`{"quoted":"say \"hello\"","slash":"\/","unicode":"\u0061","backslash":"\\"}`,
  },
  { name: "literal Markdown", text: '{"text":"**stars**"}' },
  { name: "ordinary formatted JSON", text: '{\n  "count": 42,\n  "ready": true\n}' },
];

const containers: HTMLElement[] = [];

function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
});

describe.each(["user", "assistant", "toolResult"])("%s JSON message text", (role) => {
  function renderMessage(text: string, isStreaming = false) {
    const container = createContainer();
    render(
      renderGroupedMessage(
        {
          role,
          content: text,
          ...(role === "toolResult" ? { toolName: "lookup", toolCallId: "json-result" } : {}),
        },
        "json-message",
        { isStreaming, showReasoning: false, isToolMessageExpanded: () => true },
      ),
      container,
    );
    return container;
  }

  it.each(jsonSources)("preserves $name in the expanded JSON disclosure", ({ text }) => {
    const container = renderMessage(text);
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-json-collapse");
    expect(disclosure).not.toBeNull();
    disclosure!.querySelector<HTMLElement>("summary")!.click();
    expect(disclosure!.open).toBe(true);
    expect(disclosure!.querySelector("code")?.textContent).toBe(text);
    expect(disclosure!.querySelector("strong")).toBeNull();
  });

  it.each([19_999, 20_000, 20_001])(
    "retains the JSON disclosure boundary at %i characters",
    (size) => {
      const text = '{"text":"' + "x".repeat(size - 11) + '"}';
      expect(text).toHaveLength(size);
      const container = renderMessage(text);
      const disclosure = container.querySelector<HTMLDetailsElement>(".chat-json-collapse");
      if (size <= 20_000) {
        expect(disclosure).not.toBeNull();
        disclosure!.querySelector<HTMLElement>("summary")!.click();
        expect(disclosure!.open).toBe(true);
        expect(disclosure!.querySelector("code")?.textContent).toBe(text);
      } else {
        expect(disclosure).toBeNull();
        expect(container.textContent).toContain(text);
      }
    },
  );

  it("keeps explicitly fenced JSON literal without another disclosure", () => {
    const text = '{"id":9007199254740993,"text":"**stars**"}';
    const fenced = "```json\n" + text + "\n```";
    const container = renderMessage(fenced);
    expect(container.querySelector(".chat-json-collapse")).toBeNull();
    // Tool cards show raw output; authored message Markdown consumes its fence.
    expect(container.querySelector("pre code")?.textContent?.trimEnd()).toBe(
      role === "toolResult" ? fenced : text,
    );
    expect(container.querySelector("pre strong")).toBeNull();
  });

  if (role === "assistant") {
    it("does not auto-disclose a streaming JSON message", () => {
      const text = "[9007199254740993,1e400,-0]";
      const container = renderMessage(text, true);
      expect(container.querySelector(".chat-json-collapse")).toBeNull();
      expect(container.textContent).toContain(text);
    });
  }

  it("keeps invalid JSON as ordinary message output", () => {
    const text = '{"count": }';
    const container = renderMessage(text);
    expect(container.querySelector(".chat-json-collapse")).toBeNull();
    expect(container.textContent).toContain(text);
  });
});

describe("tool JSON details", () => {
  function openToolDetails(text: string) {
    const container = createContainer();
    const openSidebar = vi.fn<(content: SidebarContent) => void>();
    render(
      renderToolCard(
        { id: "json-tool", name: "lookup", outputText: text, completed: true },
        { expanded: true, onToggleExpanded: vi.fn(), onOpenSidebar: openSidebar },
      ),
      container,
    );
    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(text);
    container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")!.click();
    expect(openSidebar).toHaveBeenCalledOnce();
    const content = openSidebar.mock.calls[0]?.[0];
    expect(content?.kind).toBe("markdown");
    if (content?.kind !== "markdown") {
      throw new Error("Expected tool details Markdown");
    }
    expect(content.rawText).toBe(text);
    const panel = createContainer();
    panel.innerHTML = toSanitizedMarkdownHtml(content.content);
    return panel;
  }

  it.each(jsonSources)("preserves $name after opening tool details", ({ text }) => {
    const panel = openToolDetails(text);
    expect(panel.querySelector("pre code")?.textContent?.trimEnd()).toBe(text);
    expect(panel.querySelector("pre strong")).toBeNull();
  });

  it.each([19_999, 20_000, 20_001])("keeps %i-character JSON output literal in details", (size) => {
    const text = '{"text":"**stars**' + "x".repeat(size - 20) + '"}';
    expect(text).toHaveLength(size);
    const panel = openToolDetails(text);
    expect(panel.querySelector("pre code")?.textContent?.trimEnd()).toBe(text);
    expect(panel.querySelector("pre strong")).toBeNull();
  });

  it("keeps explicitly fenced JSON output literal in details", () => {
    const text = '{"id":9007199254740993,"text":"**stars**"}';
    const panel = openToolDetails("```json\n" + text + "\n```");
    expect(panel.querySelector("pre code")?.textContent?.trimEnd()).toBe(text);
    expect(panel.querySelector("pre strong")).toBeNull();
  });

  it("keeps invalid JSON as ordinary detail output", () => {
    const text = '{"count": }';
    const panel = openToolDetails(text);
    expect(panel.querySelector("pre code")).toBeNull();
    expect(panel.textContent).toContain(text);
  });
});
