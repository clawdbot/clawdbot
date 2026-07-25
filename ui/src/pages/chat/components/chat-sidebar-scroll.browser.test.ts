import { describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.css";
import type { SidebarContent } from "./chat-sidebar.ts";
import "./chat-sidebar.ts";

const browserMode = "__vitest_browser__" in globalThis;

type DetailPanel = HTMLElement & {
  content: SidebarContent;
  updateComplete: Promise<unknown>;
};

describe.runIf(browserMode)("chat markdown sidebar layout", () => {
  it("keeps long markdown scrollable inside a bounded sidebar", async () => {
    const container = document.createElement("div");
    container.style.cssText = "display:flex;width:480px;height:320px;";

    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.className = "chat-sidebar";
    panel.content = {
      kind: "markdown",
      content: Array.from(
        { length: 40 },
        (_, index) => `## Section ${index + 1}\n\nLong preview content for scrolling.`,
      ).join("\n\n"),
    };
    container.append(panel);
    document.body.append(container);

    try {
      await panel.updateComplete;
      const content = panel.querySelector<HTMLElement>(".sidebar-content");
      expect(content).not.toBeNull();
      expect(content!.clientHeight).toBeLessThan(content!.scrollHeight);

      content!.scrollTop = content!.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(content!.scrollTop).toBeGreaterThan(0);
    } finally {
      container.remove();
    }
  });
});
