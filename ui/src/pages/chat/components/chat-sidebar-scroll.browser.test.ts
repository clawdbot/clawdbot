import { html, LitElement } from "lit";
import { describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import { renderReadOnlyTranscript } from "./chat-read-only-transcript.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import "./chat-sidebar.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { threadProps } from "./chat-transcript.test-support.ts";

const browserMode = "__vitest_browser__" in globalThis;

class ReadOnlyTranscriptFixture extends LitElement {
  private readonly transcript = new ChatTranscriptController(this);
  private readonly messages = [
    {
      role: "user",
      content:
        "Inspect the available tools and report their input schemas, including required parameters and optional fields, so the review can confirm that the next step uses the correct tool contract.",
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "schema-call",
          name: "exec",
          arguments: {
            code: `const schemas=await tools.describe({names:["example.search"]});text(schemas);const marker="${"x".repeat(510)}";`,
            description: "Get live tool schemas",
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "schema-call",
      toolName: "exec",
      content: [{ type: "text", text: "Schemas ready." }],
    },
  ];

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    return html`<div class="sidebar-content chat-task-detail__content">
      <div class="chat-task-detail__transcript">
        ${renderReadOnlyTranscript({
          chat: {
            ...threadProps("sidebar-resize"),
            showToolCalls: true,
            autoExpandToolCalls: true,
            onRequestUpdate: () => this.requestUpdate(),
          },
          paneId: "sidebar-resize",
          sessionKey: "agent:main:sidebar-resize",
          transcript: this.transcript,
          messages: this.messages,
        })}
      </div>
    </div>`;
  }
}

customElements.define("test-sidebar-resize-transcript", ReadOnlyTranscriptFixture);

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
  it.each(["ltr", "rtl"])(
    "reflows task messages without clipping tool borders in %s",
    async (dir) => {
      const container = document.createElement("div");
      container.className = "side-panel__panel";
      container.dir = dir;
      container.style.cssText = "width:300px;height:600px;";
      const panel = new ReadOnlyTranscriptFixture();
      panel.className = "sidebar-panel chat-task-detail";
      container.append(panel);
      document.body.append(container);

      try {
        await panel.updateComplete;
        await expect.poll(() => panel.querySelector(".chat-tool-msg-body")).not.toBeNull();
        const bubble = panel.querySelector<HTMLElement>(".user .chat-bubble")!;
        const body = panel.querySelector<HTMLElement>(".chat-tool-msg-body")!;
        const row = body.closest<HTMLElement>(".chat-virtual-row")!;
        const narrow = bubble.getBoundingClientRect();
        const narrowToolWidth = body.getBoundingClientRect().width;
        for (const width of [300, 400, 600, 700]) {
          container.style.width = `${width}px`;
          await new Promise(requestAnimationFrame);
          const clip = row.getBoundingClientRect();
          for (const selector of [
            ".chat-tool-msg-body",
            ".chat-tool-msg-summary",
            ".chat-tool-card__block-content",
            ".chat-tool-card__outcome",
          ]) {
            const bounds = panel.querySelector(selector)!.getBoundingClientRect();
            expect(bounds.left).toBeGreaterThanOrEqual(clip.left);
            expect(bounds.right).toBeLessThanOrEqual(clip.right);
          }
          expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
        }
        const wide = bubble.getBoundingClientRect();
        expect(wide.width).toBeGreaterThan(narrow.width + 150);
        expect(wide.height).toBeLessThan(narrow.height);
        expect(body.getBoundingClientRect().width).toBeGreaterThan(narrowToolWidth + 290);
      } finally {
        container.remove();
      }
    },
  );

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
