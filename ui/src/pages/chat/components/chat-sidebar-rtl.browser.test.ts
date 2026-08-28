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

// Same host contract as chat-sidebar-scroll.browser.test.ts: the panel only
// bounds itself through `.side-panel__panel`.
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

const HEBREW_DOCUMENT = [
  "## כותרת המסמך",
  "",
  "> ציטוט בעברית",
  "",
  "- פריט ראשון",
  "- פריט שני",
  "- [ ] משימה פתוחה",
].join("\n");

const ENGLISH_DOCUMENT = [
  "## Document heading",
  "",
  "> An English quote",
  "",
  "- First item",
  "- [ ] An open task",
].join("\n");

describe.runIf(browserMode)("chat sidebar markdown direction", () => {
  it("mirrors the rendered document for a right-to-left language", async () => {
    const { panel, release } = mountDetailPanel({ kind: "markdown", content: HEBREW_DOCUMENT });

    try {
      await panel.updateComplete;
      const reader = panel.querySelector<HTMLElement>(".sidebar-markdown-reader");
      expect(reader?.getAttribute("dir")).toBe("rtl");

      // The quote bar, the list indent and the task-list checkbox gap are the
      // three physical offsets a right-to-left document gets wrong when styles
      // use left/right directly.
      const quote = getComputedStyle(reader!.querySelector("blockquote")!);
      expect(quote.borderRightWidth).toBe("3px");
      expect(quote.borderLeftWidth).toBe("0px");

      const list = getComputedStyle(reader!.querySelector("ul")!);
      expect(Number.parseFloat(list.paddingRight)).toBeGreaterThan(0);
      expect(Number.parseFloat(list.paddingLeft)).toBe(0);

      // The gap belongs between the box and its label. In RTL the label sits to
      // the left of the box, so a physical margin-right would push it out to
      // the far side of the row instead.
      //
      // Asserted as "the sheet's 0.4em landed on this physical side", not as
      // "the other side is 0": the UA sheet gives a checkbox its own
      // `margin: 3px 3px 3px 4px`, and the rule here overrides only the
      // inline-end side, so the opposite side keeps that default.
      const checkbox = getComputedStyle(reader!.querySelector(".task-list-item-checkbox")!);
      const gap = Number.parseFloat(checkbox.fontSize) * 0.4;
      expect(Number.parseFloat(checkbox.marginLeft)).toBeCloseTo(gap, 0);
    } finally {
      release();
    }
  });

  it("leaves a left-to-right document untouched", async () => {
    const { panel, release } = mountDetailPanel({ kind: "markdown", content: ENGLISH_DOCUMENT });

    try {
      await panel.updateComplete;
      const reader = panel.querySelector<HTMLElement>(".sidebar-markdown-reader");
      expect(reader?.getAttribute("dir")).toBe("ltr");

      const quote = getComputedStyle(reader!.querySelector("blockquote")!);
      expect(quote.borderLeftWidth).toBe("3px");
      expect(quote.borderRightWidth).toBe("0px");

      const list = getComputedStyle(reader!.querySelector("ul")!);
      expect(Number.parseFloat(list.paddingLeft)).toBeGreaterThan(0);
      expect(Number.parseFloat(list.paddingRight)).toBe(0);

      const checkbox = getComputedStyle(reader!.querySelector(".task-list-item-checkbox")!);
      const gap = Number.parseFloat(checkbox.fontSize) * 0.4;
      expect(Number.parseFloat(checkbox.marginRight)).toBeCloseTo(gap, 0);
    } finally {
      release();
    }
  });

  it("gives each line of a code block its own direction", async () => {
    const { panel, release } = mountDetailPanel({
      kind: "markdown",
      content: ["```", "שורה בעברית", "an english line", "```"].join("\n"),
    });

    try {
      await panel.updateComplete;
      const pre = panel.querySelector<HTMLElement>(".sidebar-markdown-reader pre");
      expect(pre).not.toBeNull();
      expect(getComputedStyle(pre!).unicodeBidi).toBe("plaintext");
    } finally {
      release();
    }
  });

  // `.sidebar-markdown` is shared with the skills, session-progress-card and
  // agent status-file previews, none of which set a document direction. Those
  // surfaces must keep their existing code-block rendering, so the line-level
  // bidi rule stays scoped to the reader.
  it("leaves code blocks alone on shared markdown surfaces without the reader", () => {
    const surface = document.createElement("div");
    surface.className = "sidebar-markdown";
    const pre = document.createElement("pre");
    pre.textContent = "שורה בעברית\nan english line";
    surface.append(pre);
    document.body.append(surface);

    try {
      expect(getComputedStyle(pre).unicodeBidi).not.toBe("plaintext");
    } finally {
      surface.remove();
    }
  });
});
