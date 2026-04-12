import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("chat markdown rendering", () => {
  it("renders markdown inside tool output sidebar", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const timestamp = Date.now();
    app.chatMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolcall", name: "noop", arguments: {} },
          { type: "toolresult", name: "noop", text: "Hello **world**" },
        ],
        timestamp,
      },
    ];

    await app.updateComplete;

    const toolSummary = app.querySelector<HTMLElement>(".chat-tool-msg-summary");
    expect(toolSummary).not.toBeNull();
    toolSummary?.click();

    await app.updateComplete;

    const openSidebarButton = app.querySelector<HTMLElement>(".chat-tool-card__action-btn");
    expect(openSidebarButton).not.toBeNull();
    openSidebarButton?.click();

    await app.updateComplete;

    const strongNodes = Array.from(app.querySelectorAll(".sidebar-markdown strong"));
    expect(strongNodes.some((node) => node.textContent === "world")).toBe(true);
  });
});
