/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import { renderMcp } from "./mcp.ts";

type McpViewProps = Parameters<typeof renderMcp>[0];

function createProps(overrides: Partial<McpViewProps> = {}): McpViewProps {
  return {
    configObject: {
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            auth: "oauth",
            toolFilter: { include: ["search"] },
          },
          local: {
            command: "node",
            enabled: false,
            supportsParallelToolCalls: true,
          },
        },
      },
    },
    pluginsHref: "/settings/plugins",
    editor: html`<div class="test-editor"></div>`,
    ...overrides,
  };
}

function buttonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} button`);
  }
  return button;
}

describe("renderMcp", () => {
  it("renders summary counts, operator commands, and the managed servers card", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps()), container);

    const summary = container.querySelector(".mcp-page__summary");
    expect(summary?.textContent).toContain("Servers");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("Servers 2");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("Enabled 1");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("OAuth 1");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("Filtered 1");
    expect(container.textContent).toContain("openclaw mcp doctor --probe");

    const card = container.querySelector("openclaw-mcp-servers-card");
    expect(card).not.toBeNull();
    expect(card?.pluginsHref).toBe("/settings/plugins");
  });

  it("keeps the summary free of save actions and preserves the embedded editor", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps()), container);

    expect(buttonByText.bind(null, container, "Save")).toThrow();
    expect(buttonByText.bind(null, container, "Save & Publish")).toThrow();
    expect(container.querySelector(".test-editor")).not.toBeNull();
  });
});
