/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
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
    configDirty: true,
    configSaving: false,
    configApplying: false,
    connected: true,
    pluginsHref: "/settings/plugins",
    onSaveConfig: vi.fn(),
    onApplyConfig: vi.fn(),
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
  it("summarizes configured MCP servers and links management to Plugins", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps()), container);

    expect(container.querySelector(".mcp-page__summary")?.textContent).toContain("Servers");
    expect(container.querySelector(".mcp-server-list")?.textContent).toContain("docs");
    expect(container.querySelector(".mcp-server-list")?.textContent).toContain("local");
    expect(container.querySelector(".mcp-server-list")?.textContent).toContain(
      "openclaw mcp login docs",
    );

    expect(
      container.querySelector<HTMLAnchorElement>('a[href="/settings/plugins"]')?.textContent,
    ).toContain("Manage servers on the Plugins page.");
    expect(buttonByText.bind(null, container, "Enable")).toThrow();
    expect(buttonByText.bind(null, container, "Disable")).toThrow();
  });

  it("renders an empty state when no MCP servers are configured", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps({ configObject: {} })), container);

    expect(container.querySelector(".settings-empty")?.textContent).toContain(
      "No MCP servers configured.",
    );
  });

  it("does not enable publish when config is unchanged", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps({ configDirty: false })), container);

    expect(buttonByText(container, "Save & Publish").disabled).toBe(true);
  });

  it("disables save actions while offline or saving", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps({ connected: false })), container);
    expect(buttonByText(container, "Save").disabled).toBe(true);
    expect(buttonByText(container, "Save & Publish").disabled).toBe(true);

    render(renderMcp(createProps({ configSaving: true })), container);
    expect(buttonByText(container, "Save").disabled).toBe(true);
    expect(buttonByText(container, "Save & Publish").disabled).toBe(true);
  });

  it("quotes MCP server names in command snippets", () => {
    const container = document.createElement("div");

    render(
      renderMcp(
        createProps({
          configObject: {
            mcp: {
              servers: {
                "docs; echo unsafe": {
                  url: "https://mcp.example.com/mcp",
                },
              },
            },
          },
        }),
      ),
      container,
    );

    const text = container.querySelector(".mcp-server-list")?.textContent ?? "";
    expect(text).toContain("openclaw mcp probe 'docs; echo unsafe'");
  });

  it("redacts sensitive URL values in server summaries", () => {
    const container = document.createElement("div");

    render(
      renderMcp(
        createProps({
          configObject: {
            mcp: {
              servers: {
                docs: {
                  url: "https://user:secret@mcp.example.com/mcp?token=query-secret&keep=visible",
                },
              },
            },
          },
        }),
      ),
      container,
    );

    const text = container.querySelector(".mcp-server-list")?.textContent ?? "";
    expect(text).toContain("https://***:***@mcp.example.com/mcp?token=***&keep=visible");
    expect(text).not.toContain("secret");
  });

  it("redacts sensitive malformed URL-like values in server summaries", () => {
    const container = document.createElement("div");

    render(
      renderMcp(
        createProps({
          configObject: {
            mcp: {
              servers: {
                docs: {
                  url: "//user:secret@mcp.example.com/mcp?token=query-secret&keep=visible",
                },
              },
            },
          },
        }),
      ),
      container,
    );

    const text = container.querySelector(".mcp-server-list")?.textContent ?? "";
    expect(text).toContain("//***:***@mcp.example.com/mcp?token=***&keep=visible");
    expect(text).not.toContain("secret");
  });
});
