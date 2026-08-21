/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderToolCard } from "./chat-tool-cards.ts";

// Outcome presentation for tool cards: neutral collapsed rows, the expanded
// outcome line, and the compact progress_card receipt.
describe("tool-card outcomes", () => {
  it("renders error details with the failure outcome in the expanded body", () => {
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

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Web Search",
    );
    const expandedCard = container.querySelector(".chat-tool-card");
    expect(expandedCard?.classList.contains("chat-tool-card--error")).toBe(true);
    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
    expect(
      Array.from(container.querySelectorAll(".chat-tool-card__block-label")).map(
        (label) => label.textContent,
      ),
    ).toContain("Tool error");
  });

  it("renders a neutral summary for a status-only error payload", () => {
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

    const summary = container.querySelector(".chat-tool-msg-summary");
    expect(summary?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Sub-agent");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
  });

  it("renders a neutral summary when output is the literal 'Tool not found'", () => {
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

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Unknown",
    );
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("renders a neutral summary when the tool card has an explicit error flag", () => {
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

    const summary = container.querySelector(".chat-tool-msg-summary");
    expect(summary?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Lookup");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
  });

  it("renders a plain error detail when a failed tool has no output", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:no-output",
          name: "lookup",
          isError: true,
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
    expect(container.querySelector(".chat-tool-card__block-label")?.textContent).toBe("Tool error");
    expect(container.querySelector(".chat-tool-card__block-content")?.textContent).toBe(
      "No output — tool failed.",
    );
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

  it("renders successful output without redundant Tool output labelling", () => {
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

    expect(container.textContent).toContain("Opened page");
    expect(container.textContent).not.toContain("Tool output");
    expect(container.textContent).not.toContain("Tool error");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
  });

  it.each([
    {
      args: {
        markdown: "Implementation is moving.",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ],
      },
      expected: "Progress updated — 1/3 · Implement",
    },
    { args: { markdown: "Waiting on review." }, expected: "Progress note updated" },
  ])("renders progress_card as a compact receipt: $expected", ({ args, expected }) => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: `progress:${expected}`,
          name: "progress_card",
          args,
          outputText: "Progress card updated",
          completed: true,
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent?.trim()).toBe(expected);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(container.textContent).not.toContain("Waiting on review.");
  });
});
