import { html, render, type CSSResult } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  renderPanelLoadingSkeleton,
  type PanelLoadingSkeletonVariant,
} from "./panel-loading-skeleton.ts";

const variants = [
  "board",
  "browser",
  "chat",
  "desktop",
  "discussion",
  "files",
  "review",
  "tasks",
  "terminal",
] satisfies PanelLoadingSkeletonVariant[];

afterEach(() => {
  document.body.replaceChildren();
});

describe("panel loading skeleton", () => {
  it("keeps the shadow shimmer primitive declaration-identical to base.css", () => {
    const component = customElements.get(
      "openclaw-panel-loading-skeleton",
    ) as CustomElementConstructor & {
      styles: CSSResult | CSSResult[];
    };
    const styles = Array.isArray(component.styles) ? component.styles : [component.styles];
    const shadowCss = styles.map((style) => style.cssText).join("\n");
    const baseCss = readStyleSheet("ui/src/styles/base.css");

    function extractBlock(cssText: string, selector: string): string {
      const source = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
      let depth = 0;
      let start = 0;
      let header = "";
      for (const match of source.matchAll(/[{}]/g)) {
        if (match[0] === "{") {
          if (depth === 0) {
            header = source.slice(start, match.index).trim();
          }
          depth += 1;
        } else {
          depth -= 1;
          if (depth === 0) {
            if (header === selector) {
              return source
                .slice(start, match.index + 1)
                .replace(/\s+/g, " ")
                .replace(/\s*([{};:,])\s*/g, "$1")
                .trim();
            }
            start = match.index + 1;
          }
        }
      }
      throw new Error(`Missing top-level ${selector} block`);
    }

    for (const selector of ["@keyframes shimmer", ".skeleton", ".skeleton::after"]) {
      expect(extractBlock(shadowCss, selector), `${selector} must match base.css`).toBe(
        extractBlock(baseCss, selector),
      );
    }
  });

  it.each(variants)("renders an accessible structural %s placeholder", async (variant) => {
    const mount = document.body.appendChild(document.createElement("div"));
    render(html`${renderPanelLoadingSkeleton(variant, `Loading ${variant}`)}`, mount);

    const skeleton = mount.querySelector<HTMLElement>("openclaw-panel-loading-skeleton");
    expect(skeleton).toBeInstanceOf(HTMLElement);
    await (skeleton as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(skeleton?.dataset.panelSkeleton).toBe(variant);
    expect(skeleton?.getAttribute("aria-label")).toBe(`Loading ${variant}`);
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
    expect(skeleton?.shadowRoot?.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
  });

  it("supports a compact structural placeholder for nested loading surfaces", async () => {
    const mount = document.body.appendChild(document.createElement("div"));
    render(html`${renderPanelLoadingSkeleton("terminal", "Loading sessions", true)}`, mount);

    const skeleton = mount.querySelector<HTMLElement>("openclaw-panel-loading-skeleton");
    await (skeleton as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(skeleton?.hasAttribute("compact")).toBe(true);
  });

  it("supports an overlay placeholder for retained viewport chrome", async () => {
    const mount = document.body.appendChild(document.createElement("div"));
    render(html`${renderPanelLoadingSkeleton("desktop", "Connecting", false, true)}`, mount);

    const skeleton = mount.querySelector<HTMLElement>("openclaw-panel-loading-skeleton");
    await (skeleton as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(skeleton?.hasAttribute("overlay")).toBe(true);
  });
});
