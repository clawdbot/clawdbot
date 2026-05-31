/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SidebarContent } from "./sidebar-content.ts";

describe("OpenClawApp full-message sidebar upgrade", () => {
  async function createApp() {
    await import("./app.ts");
    return document.createElement("openclaw-app") as import("./app.ts").OpenClawApp;
  }

  it("uses string content returned by chat.message.get", async () => {
    const content: SidebarContent = {
      kind: "markdown",
      content: "short\n...(truncated)...",
      fullMessageRequest: {
        sessionKey: "main",
        messageId: "msg-1",
        kind: "assistant_message",
      },
    };
    const request = vi.fn(async () => ({
      ok: true,
      message: { role: "assistant", content: "full assistant text" },
    }));
    const app = await createApp();
    app.client = { request } as never;

    app.handleOpenSidebar(content);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("chat.message.get", {
        sessionKey: "main",
        messageId: "msg-1",
        maxChars: 500_000,
      });
      expect(app.sidebarContent).toMatchObject({
        kind: "markdown",
        content: "full assistant text",
        rawText: "full assistant text",
        unavailableReason: null,
      });
    });
  });

  it("updates canvas raw text from chat.message.get", async () => {
    const content: SidebarContent = {
      kind: "canvas",
      docId: "preview-1",
      entryUrl: "https://example.test/preview",
      rawText: "short\n...(truncated)...",
      fullMessageRequest: {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-2",
        kind: "tool_output",
      },
    };
    const request = vi.fn(async () => ({
      ok: true,
      message: { role: "assistant", text: "full canvas raw text" },
    }));
    const app = await createApp();
    app.client = { request } as never;

    app.handleOpenSidebar(content);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("chat.message.get", {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-2",
        maxChars: 500_000,
      });
      expect(app.sidebarContent).toMatchObject({
        kind: "canvas",
        docId: "preview-1",
        entryUrl: "https://example.test/preview",
        rawText: "full canvas raw text",
        unavailableReason: null,
      });
    });
  });
});
