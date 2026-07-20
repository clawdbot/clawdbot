/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { mcpAppWidgetNameForViewId, type BoardProvider } from "../../../lib/board/provider.ts";
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

  it("pins normalized Canvas HTML through the board provider", async () => {
    const pinWidget = vi.fn(async () => undefined);
    const snapshotSignal = {
      value: {
        sessionKey: "agent:main:main",
        revision: 0,
        tabs: [],
        widgets: [],
      } as BoardProvider["snapshot$"]["value"],
      subscribe: () => () => {},
    };
    const provider = {
      sessionKey: "agent:main:main",
      canPinWidgets: true,
      pinWidget,
      snapshot$: snapshotSignal,
    } as unknown as BoardProvider;
    const canvas = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          title: "Release status",
          viewId: " cv_release ",
          url: "/__openclaw__/canvas/documents/cv_release/index.html",
          sandbox: "scripts",
        },
        "chat_message",
        { boardProvider: provider },
      ),
      canvas,
    );

    canvas.querySelector<HTMLButtonElement>("[data-pin-widget]")?.click();
    await vi.waitFor(() => {
      expect(pinWidget).toHaveBeenCalledWith({
        docId: "cv_release",
        name: "canvas-cv_release",
        title: "Release status",
      });
    });

    snapshotSignal.value = {
      sessionKey: "agent:main:main",
      revision: 1,
      tabs: [],
      widgets: [
        {
          name: "release-status",
          tabId: "main",
          contentKind: "html",
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "none",
          revision: 1,
        },
      ],
    };
    const pinned = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_release",
          boardWidgetName: "release-status",
          url: "/__openclaw__/canvas/documents/cv_release/index.html",
          sandbox: "scripts",
        },
        "chat_message",
        { boardProvider: provider },
      ),
      pinned,
    );
    expect(pinned.querySelector<HTMLButtonElement>("[data-pin-widget]")?.disabled).toBe(true);
    expect(pinned.querySelector("[data-pin-widget]")?.textContent).toContain("Pinned");

    const external = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_external",
          url: "https://example.com/widget.html",
          sandbox: "scripts",
        },
        "chat_message",
        { allowExternalEmbedUrls: true, boardProvider: provider },
      ),
      external,
    );
    expect(external.querySelector("[data-pin-widget]")).toBeNull();

    const mismatched = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_expected",
          url: "/__openclaw__/canvas/documents/cv_other/index.html",
          sandbox: "scripts",
        },
        "chat_message",
        { boardProvider: provider },
      ),
      mismatched,
    );
    expect(mismatched.querySelector("[data-pin-widget]")).toBeNull();

    const strict = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_strict",
          url: "/__openclaw__/canvas/documents/cv_strict/index.html",
          sandbox: "strict",
        },
        "chat_message",
        { boardProvider: provider },
      ),
      strict,
    );
    expect(strict.querySelector("[data-pin-widget]")).toBeNull();

    const app = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_app",
          mcpApp: { viewId: "cv_app" },
        },
        "chat_message",
        { boardProvider: provider, sessionKey: "agent:main:main" },
      ),
      app,
    );
    expect(app.querySelector("[data-pin-widget]")).toBeNull();
  });

  it("pins an MCP App using only its view identity", async () => {
    const pinMcpApp = vi.fn(async () => undefined);
    const provider = {
      sessionKey: "agent:main:main",
      canPinWidgets: true,
      canPinMcpApps: true,
      pinMcpApp,
      snapshot$: {
        value: {
          sessionKey: "agent:main:main",
          revision: 0,
          tabs: [],
          widgets: [],
        },
        subscribe: () => () => {},
      },
    } as unknown as BoardProvider;
    const preview = {
      kind: "canvas" as const,
      surface: "assistant_message" as const,
      render: "url" as const,
      title: "Weather",
      mcpApp: {
        viewId: " mcp-app-source ",
        serverName: "weather",
        toolName: "show",
        uiResourceUri: "ui://weather/app",
        toolCallId: "call-1",
        originSessionKey: "agent:main:main",
      },
    };

    const origin = document.createElement("div");
    render(
      renderToolPreview(preview, "chat_message", {
        boardProvider: provider,
        sessionKey: "agent:main:main",
      }),
      origin,
    );
    origin.querySelector<HTMLButtonElement>("[data-pin-widget]")?.click();
    await vi.waitFor(() =>
      expect(pinMcpApp).toHaveBeenCalledWith({
        viewId: "mcp-app-source",
        name: mcpAppWidgetNameForViewId("mcp-app-source"),
        title: "Weather",
      }),
    );

    const unsupportedProvider = { ...provider, canPinMcpApps: false } as BoardProvider;
    const unsupported = document.createElement("div");
    render(
      renderToolPreview(preview, "chat_message", {
        boardProvider: unsupportedProvider,
        sessionKey: "agent:main:main",
      }),
      unsupported,
    );
    expect(unsupported.querySelector("[data-pin-widget]")).toBeNull();

    const missingView = document.createElement("div");
    render(
      renderToolPreview(
        { ...preview, mcpApp: { ...preview.mcpApp, viewId: "   " } },
        "chat_message",
        { boardProvider: provider, sessionKey: "agent:main:main" },
      ),
      missingView,
    );
    expect(missingView.querySelector("[data-pin-widget]")).toBeNull();
  });
});
