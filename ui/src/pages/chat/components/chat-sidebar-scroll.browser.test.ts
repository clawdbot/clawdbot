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

// The detail panel only bounds itself through its host: `.side-panel__panel`
// (chat-sidebar-region.runtime.ts) is what grants the panel `min-height: 0`, so
// mounting it under any other class makes the sidebar grow instead of scroll.
function mountDetailPanel(content: SidebarContent): {
  panel: DetailPanel;
  release: () => void;
} {
  const container = document.createElement("div");
  container.className = "side-panel__panel";
  container.style.cssText = "display:flex;width:480px;height:320px;";

  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.className = "chat-sidebar";
  panel.content = content;
  container.append(panel);
  document.body.append(container);

  return { panel, release: () => container.remove() };
}

describe.runIf(browserMode)("chat sidebar layout", () => {
  it("keeps long markdown scrollable inside a bounded sidebar", async () => {
    const { panel, release } = mountDetailPanel({
      kind: "markdown",
      content: Array.from(
        { length: 40 },
        (_, index) => `## Section ${index + 1}\n\nLong preview content for scrolling.`,
      ).join("\n\n"),
    });

    try {
      await panel.updateComplete;
      const content = panel.querySelector<HTMLElement>(".sidebar-content");
      expect(content).not.toBeNull();
      expect(content!.clientHeight).toBeLessThan(content!.scrollHeight);

      content!.scrollTop = content!.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(content!.scrollTop).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  it("keeps long files scrollable inside CodeMirror", async () => {
    const { panel, release } = mountDetailPanel({
      kind: "file",
      path: "src/long-example.ts",
      name: "long-example.ts",
      language: "typescript",
      content: Array.from(
        { length: 200 },
        (_, index) => `export const value${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    try {
      await panel.updateComplete;
      await expect
        .poll(() => panel.querySelector<HTMLElement>(".cm-scroller"), { timeout: 5_000 })
        .not.toBeNull();
      const scroller = panel.querySelector<HTMLElement>(".cm-scroller");
      expect(scroller).not.toBeNull();
      expect(scroller!.clientHeight).toBeLessThan(scroller!.scrollHeight);

      scroller!.scrollTop = scroller!.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(scroller!.scrollTop).toBeGreaterThan(0);
    } finally {
      release();
    }
  });
});
