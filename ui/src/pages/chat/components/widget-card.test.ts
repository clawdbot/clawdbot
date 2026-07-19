/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderToolPreview } from "./widget-card.ts";

describe("widget-card", () => {
  it("dispatches canvas HTML and MCP App content and ignores unknown kinds", () => {
    const canvas = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          url: "/__openclaw__/canvas/documents/cv_dispatch/index.html",
          preferredHeight: 320,
        },
        "chat_message",
      ),
      canvas,
    );
    expect(canvas.querySelector("iframe.chat-tool-card__preview-frame")).not.toBeNull();
    expect(canvas.querySelector("mcp-app-view")).toBeNull();
    expect(canvas.querySelector('button[aria-label="Widget actions"]')).not.toBeNull();
    expect(
      Array.from(canvas.querySelectorAll("wa-dropdown-item"), (item) => item.textContent?.trim()),
    ).toEqual(["Copy to clipboard", "Download file"]);

    const app = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          title: "App",
          preferredHeight: 480,
          mcpApp: { viewId: "view-dispatch" },
        },
        "chat_message",
        { sessionKey: "agent:main:main" },
      ),
      app,
    );
    expect(app.querySelector("mcp-app-view")).not.toBeNull();
    expect(app.querySelector("iframe")).toBeNull();
    expect(app.querySelector('button[aria-label="Widget actions"]')).toBeNull();

    const unknown = document.createElement("div");
    render(renderToolPreview({ kind: "unknown" } as never, "chat_message"), unknown);
    expect(unknown.childElementCount).toBe(0);
  });
});
