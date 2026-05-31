/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolErrorOutput,
  renderToolCard,
  renderToolCardSidebar,
} from "./tool-cards.ts";

vi.mock("../icons.ts", () => ({
  icons: {
    check: "✓",
    chevronDown: "",
    panelRightOpen: "",
    x: "✕",
    zap: "",
  },
}));

vi.mock("../tool-display.ts", () => ({
  formatToolDetail: () => undefined,
  resolveToolDisplay: ({ name, args }: { name: string; args?: unknown }) => ({
    name,
    label: name
      .split(/[._-]/g)
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(" "),
    icon: "zap",
    detail:
      args && typeof args === "object" && "detail" in args
        ? String((args as { detail: unknown }).detail)
        : undefined,
  }),
}));

function requireFirstMockArg(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
    throw new Error(`expected ${label} payload`);
  }
  return arg;
}

describe("tool-cards", () => {
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

    const blocks = Array.from(container.querySelectorAll(".chat-tool-card__block"));
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool input", "Tool output"]);
    expect(blocks.map((block) => block.querySelector("code")?.textContent)).toEqual([
      '{\n  "url": "https://example.com"\n}',
      "Opened page",
    ]);
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

    const blocks = Array.from(container.querySelectorAll(".chat-tool-card__block"));
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool input"]);
    expect(blocks[0]?.querySelector("code")?.textContent).toBe(
      '{\n  "mode": "session",\n  "thread": true\n}',
    );
    expect(container.querySelector(".chat-tool-card__block-empty")).toBeNull();
  });

  it("labels collapsed tool calls with the display summary", () => {
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

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Sessions Spawn",
    );
    expect(summaryButton?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("keeps tool display labels primary for collapsed result rows with action details", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:5a:call-5a",
          name: "skill_workshop",
          args: { detail: "create" },
          inputText: '{\n  "detail": "create"\n}',
          outputText: "Proposal created",
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Skill Workshop",
    );
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "create",
    );
    expect(summaryButton?.textContent).not.toContain("output");
  });

  it("cleans connector copy from collapsed summaries without changing raw details", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:5b:call-5b",
          name: "presentation_create",
          args: "with Example Deck",
          inputText: "with Example Deck",
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Example Deck",
    );

    render(
      renderToolCard(
        {
          id: "msg:5b:call-5b",
          name: "presentation_create",
          args: "with Example Deck",
          inputText: "with Example Deck",
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(
      "with Example Deck",
    );
  });

  it("normalizes collapsed summary text for display only", () => {
    expect(formatCollapsedToolSummaryText("  with   Example Deck  ")).toBe("Example Deck");
    expect(formatCollapsedToolSummaryText("Example Deck")).toBe("Example Deck");
    expect(formatCollapsedToolSummaryText("   ")).toBeUndefined();
  });

  it("keeps collapsed markdown previews bounded after display cleanup", () => {
    const preview = formatCollapsedToolPreviewText(`with ${"A".repeat(200)}`);

    expect(preview).toHaveLength(120);
    expect(preview?.startsWith("A")).toBe(true);
    expect(preview).not.toContain("with ");
  });

  it("bounds raw string argument fallbacks in collapsed summaries", () => {
    const container = document.createElement("div");
    const rawInput = `with ${"A".repeat(200)}`;
    render(
      renderToolCard(
        {
          id: "msg:5c:call-5c",
          name: "presentation_create",
          args: rawInput,
          inputText: rawInput,
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const labelText = container.querySelector(".chat-tool-msg-summary__label")?.textContent?.trim();
    expect(labelText).toHaveLength(120);
    expect(labelText?.startsWith("A")).toBe(true);
    expect(labelText).not.toContain("with ");
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

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(rawToggle).toBeInstanceOf(HTMLButtonElement);
    expect(rawBody).toBeInstanceOf(HTMLElement);
    expect([...rawToggle!.classList]).toEqual(["chat-tool-card__raw-toggle"]);
    expect(rawToggle!.textContent?.trim()).toBe("Raw details");
    expect(rawToggle!.getAttribute("aria-expanded")).toBe("false");
    expect(rawBody!.hidden).toBe(true);

    rawToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(rawToggle!.getAttribute("aria-expanded")).toBe("true");
    expect(rawBody!.hidden).toBe(false);
    expect(rawBody!.querySelector(".chat-tool-card__block-label")?.textContent).toBe("Tool output");
    expect(JSON.parse(rawBody!.querySelector("code")?.textContent ?? "{}")).toEqual({
      kind: "canvas",
      presentation: {
        target: "tool_card",
      },
      view: {
        backend: "canvas",
        id: "cv_counter",
        preferred_height: 480,
        title: "Counter demo",
        url: "/__openclaw__/canvas/documents/cv_counter/index.html",
      },
    });
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
    expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
    expect([...sidebarButton!.classList]).toEqual(["chat-tool-card__action-btn"]);
    sidebarButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar.kind).toBe("canvas");
    expect(sidebar.docId).toBe("cv_sidebar");
    expect(sidebar.entryUrl).toBe("/__openclaw__/canvas/documents/cv_sidebar/index.html");
  });
  describe("isToolErrorOutput", () => {
    it("flags JSON payloads that carry a top-level error string", () => {
      expect(
        isToolErrorOutput(
          JSON.stringify({
            error: "missing_brave_api_key",
            message: "BRAVE_API_KEY is not configured",
            provider: "brave",
          }),
        ),
      ).toBe(true);
    });

    it("flags JSON payloads that carry a top-level isError flag", () => {
      expect(
        isToolErrorOutput(
          JSON.stringify({
            isError: true,
            content: [{ type: "text", text: "Tool error: boom" }],
          }),
        ),
      ).toBe(true);
      expect(
        isToolErrorOutput(
          JSON.stringify({
            is_error: true,
            content: [{ type: "text", text: "Tool error: boom" }],
          }),
        ),
      ).toBe(true);
    });

    it("flags 'Tool not found' bodies regardless of trailing punctuation or case", () => {
      expect(isToolErrorOutput("Tool not found")).toBe(true);
      expect(isToolErrorOutput("  tool not found.  ")).toBe(true);
      expect(isToolErrorOutput("TOOL NOT FOUND")).toBe(true);
    });

    it("flags JSON payloads with top-level failure statuses", () => {
      expect(isToolErrorOutput(JSON.stringify({ status: "error" }))).toBe(true);
      expect(isToolErrorOutput(JSON.stringify({ status: "failed" }))).toBe(true);
      expect(isToolErrorOutput(JSON.stringify({ status: "timeout" }))).toBe(true);
      expect(isToolErrorOutput(JSON.stringify({ status: "completed" }))).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ status: "ok" }))).toBe(false);
    });

    it("does not flag successful payloads or strings without a tool error signal", () => {
      expect(isToolErrorOutput(undefined)).toBe(false);
      expect(isToolErrorOutput("")).toBe(false);
      expect(isToolErrorOutput("Opened page")).toBe(false);
      expect(
        isToolErrorOutput(
          JSON.stringify({ isError: false, result: "ok", error: "no validation errors" }),
        ),
      ).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ result: "ok", error: null }))).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ result: "ok", error: "" }))).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ result: "ok" }))).toBe(false);
      expect(isToolErrorOutput("{ not really json }")).toBe(false);
    });
  });

  it("renders a Tool error label and Error badge when output is an error JSON", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:1",
          name: "web_search",
          args: { query: "python stable version" },
          inputText: '{\n  "query": "python stable version"\n}',
          outputText: JSON.stringify({
            error: "missing_brave_api_key",
            message: "BRAVE_API_KEY is not configured",
          }),
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(true);
    expect(container.querySelector(".chat-tool-msg-summary__error-badge")).not.toBeNull();
    const expandedCard = container.querySelector(".chat-tool-card--expanded");
    expect(expandedCard?.classList.contains("chat-tool-card--error")).toBe(true);
    expect(container.querySelector(".chat-tool-card__status-badge")).not.toBeNull();
  });

  it("renders a Tool error label when output has a status-only error payload", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:status-only",
          name: "sessions_spawn",
          outputText: JSON.stringify({ status: "error" }),
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    expect(container.querySelector(".chat-tool-msg-summary--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
  });

  it("renders a Tool error label when output is the literal 'Tool not found'", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:2",
          name: "Unknown",
          outputText: "Tool not found",
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(true);
    expect(container.querySelector(".chat-tool-msg-summary__error-badge")).not.toBeNull();
  });

  it("renders a Tool error label when the tool card has an explicit error flag", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:explicit",
          name: "lookup",
          outputText: "lookup failed",
          isError: true,
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    expect(container.querySelector(".chat-tool-msg-summary--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
  });

  it("respects an explicit success flag even when the payload looks like an error", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:status-false",
          name: "web_search",
          outputText: JSON.stringify({
            error: "missing_brave_api_key",
          }),
          isError: false,
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Web Search");
    expect(container.textContent).not.toContain("Tool error");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
  });

  it("does not render View with a checkmark for sidebar cards whose output is an error JSON", () => {
    const container = document.createElement("div");
    render(
      renderToolCardSidebar(
        {
          id: "msg:err:sidebar",
          name: "web_search",
          outputText: JSON.stringify({
            error: "missing_brave_api_key",
            message: "BRAVE_API_KEY is not configured",
          }),
        },
        vi.fn(),
      ),
      container,
    );

    const card = container.querySelector(".chat-tool-card");
    const action = container.querySelector(".chat-tool-card__action");
    expect(card?.classList.contains("chat-tool-card--error")).toBe(true);
    expect(action?.classList.contains("chat-tool-card__action--error")).toBe(true);
    expect(action?.textContent).toContain("View error");
    expect(action?.textContent).toContain("✕");
    expect(action?.textContent).not.toContain("✓");
  });

  it("marks Tool not found sidebar output as an error instead of View with a checkmark", () => {
    const container = document.createElement("div");
    render(
      renderToolCardSidebar(
        {
          id: "msg:err:sidebar-tool-not-found",
          name: "Unknown",
          outputText: "Tool not found",
        },
        vi.fn(),
      ),
      container,
    );

    const action = container.querySelector(".chat-tool-card__action");
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
    expect(action?.textContent).toContain("View error");
    expect(action?.textContent).toContain("✕");
    expect(action?.textContent).not.toContain("✓");
  });

  it("marks status-only sidebar output as an error instead of View with a checkmark", () => {
    const container = document.createElement("div");
    render(
      renderToolCardSidebar(
        {
          id: "msg:err:sidebar-status",
          name: "sessions_wait",
          outputText: JSON.stringify({ status: "timeout" }),
        },
        vi.fn(),
      ),
      container,
    );

    const action = container.querySelector(".chat-tool-card__action");
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
    expect(action?.textContent).toContain("View error");
    expect(action?.textContent).toContain("✕");
    expect(action?.textContent).not.toContain("✓");
  });

  it("keeps Tool output labelling for successful results", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:ok:1",
          name: "browser.open",
          outputText: "Opened page",
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).not.toContain("Tool error");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
  });
  it("does not add a full-message request for ambiguous tool details", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:tool:full",
          name: "browser.open",
          outputText: "Opened page",
          messageId: "msg-tool-full",
        },
        {
          expanded: true,
          sessionKey: "main",
          agentId: "work",
          onToggleExpanded: vi.fn(),
          onOpenSidebar,
        },
      ),
      container,
    );

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");
    expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
    sidebarButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar.kind).toBe("markdown");
    expect(sidebar.fullMessageRequest).toBeUndefined();
  });
});
