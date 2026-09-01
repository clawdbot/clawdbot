import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderPanelLoadingSkeleton,
  type PanelLoadingSkeletonVariant,
} from "./panel-loading-skeleton.ts";

const variants = [
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
