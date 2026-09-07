// One lifecycle owner for interactive Markdown in transcripts and previews.
import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { t } from "../i18n/index.ts";
import { updateCodeBlockWidthOverflow } from "./markdown-code-blocks.ts";
import { enhanceMarkdownTables, releaseMarkdownTables } from "./markdown-tables.ts";

let codeBlockRegionSequence = 0;
const initializedCodeBlocks = new WeakSet<HTMLElement>();

function updateListMarkerWidth(probe: HTMLElement): void {
  probe.parentElement?.style.setProperty(
    "--chat-markdown-marker-width",
    `${Math.ceil(probe.getBoundingClientRect().width)}px`,
  );
}

class MarkdownBlocksDirective extends AsyncDirective {
  private root: HTMLElement | undefined;
  private scanPending = false;
  private readonly observedNodes = new Set<HTMLElement>();
  private readonly resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          for (const { target } of entries) {
            if (
              target instanceof HTMLElement &&
              target.classList.contains("markdown-list-marker-measure")
            ) {
              updateListMarkerWidth(target);
            }
          }
          const wrappers = new Set(
            entries.map(({ target }) => target.closest<HTMLElement>(".code-block-wrapper")),
          );
          for (const wrapper of wrappers) {
            if (wrapper) {
              updateCodeBlockWidthOverflow(wrapper);
            }
          }
        });

  render() {
    return nothing;
  }

  override update(part: ElementPart) {
    this.root = part.element instanceof HTMLElement ? part.element : undefined;
    this.scheduleScan();
    return nothing;
  }

  protected override disconnected(): void {
    // A final route-away has no later scan to release detached transcript trees.
    this.resizeObserver?.disconnect();
    this.observedNodes.clear();
    if (this.root) {
      releaseMarkdownTables(this.root);
    }
  }

  protected override reconnected(): void {
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scanPending || !this.isConnected) {
      return;
    }
    this.scanPending = true;
    // Element directives commit before their children. Coalesce after the commit,
    // and fence queued scans when the host is removed before the microtask runs.
    queueMicrotask(() => {
      this.scanPending = false;
      if (this.isConnected && this.root?.isConnected) {
        this.scan(this.root);
      }
    });
  }

  private scan(root: HTMLElement): void {
    enhanceMarkdownTables(root);
    for (const prose of [
      root,
      ...root.querySelectorAll<HTMLElement>(".chat-text, .chat-thinking"),
    ]) {
      if (!prose.matches(".chat-text, .chat-thinking")) {
        continue;
      }
      let probe = prose.querySelector<HTMLElement>(":scope > .markdown-list-marker-measure");
      const lists = prose.querySelectorAll<HTMLOListElement>("ol");
      if (lists.length === 0) {
        probe?.remove();
        prose.style.removeProperty("--chat-markdown-marker-width");
        continue;
      }
      if (!probe) {
        probe = document.createElement("span");
        probe.className = "markdown-list-marker-measure";
        probe.setAttribute("aria-hidden", "true");
        prose.append(probe);
      }
      // Intrinsic width measures every counter in the actual font. Font and scale
      // changes resize the probe without replacing native list markers.
      const markers: string[] = [];
      for (const list of lists) {
        for (let index = 0; index < list.children.length; index++) {
          markers.push(`${list.start + index}. `);
        }
      }
      probe.textContent = markers.join("\n");
      updateListMarkerWidth(probe);
      if (!this.observedNodes.has(probe)) {
        this.observedNodes.add(probe);
        this.resizeObserver?.observe(probe);
      }
    }
    if (root.querySelector(".markdown-mermaid pre code")) {
      void import("./markdown-mermaid.ts").then(
        ({ mountMermaidBlocks }) => {
          if (
            this.isConnected &&
            this.root === root &&
            root.isConnected &&
            mountMermaidBlocks(root)
          ) {
            this.scheduleScan();
          }
        },
        () => {
          for (const block of root.querySelectorAll(".markdown-mermaid")) {
            block.classList.remove("markdown-mermaid");
            block.prepend(t("chat.mermaid.rendererError"));
          }
        },
      );
    }
    for (const node of this.observedNodes) {
      if (!root.contains(node)) {
        this.resizeObserver?.unobserve(node);
        this.observedNodes.delete(node);
      }
    }
    for (const wrapper of root.querySelectorAll<HTMLElement>(".code-block-wrapper")) {
      const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport");
      const code = viewport?.querySelector<HTMLElement>("code");
      if (!viewport || !code) {
        continue;
      }
      if (!initializedCodeBlocks.has(wrapper)) {
        initializedCodeBlocks.add(wrapper);
        const expandButton = wrapper.querySelector<HTMLButtonElement>(".code-block-expand");
        if (expandButton) {
          const regionId = `code-block-${++codeBlockRegionSequence}`;
          viewport.id = regionId;
          expandButton.setAttribute("aria-controls", regionId);
        }
      }
      // A reconnected host reuses initialized DOM but must reacquire observation.
      for (const node of [viewport, code]) {
        if (!this.observedNodes.has(node)) {
          this.observedNodes.add(node);
          this.resizeObserver?.observe(node);
        }
      }
      if (!this.resizeObserver) {
        updateCodeBlockWidthOverflow(wrapper);
      }
    }
  }
}

export const markdownBlocks = directive(MarkdownBlocksDirective);
