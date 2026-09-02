/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

type TooltipElement = HTMLElement & {
  closeDelay: number;
  content: string;
  delay: number;
  openOnClick: boolean;
  readonly updateComplete: Promise<boolean>;
};

type TooltipProviderElement = HTMLElement & {
  delay: number;
  skipDelay: number;
};

function createTooltip(content: string, triggerText = "trigger") {
  const tooltip = document.createElement("openclaw-tooltip") as TooltipElement;
  tooltip.content = content;
  const trigger = document.createElement("button");
  trigger.textContent = triggerText;
  tooltip.append(trigger);
  return { tooltip, trigger };
}

function createRichTooltip(content: string, triggerText = "trigger") {
  const tooltip = document.createElement("openclaw-tooltip") as TooltipElement;
  const trigger = document.createElement("button");
  trigger.textContent = triggerText;
  const card = document.createElement("div");
  card.slot = "content";
  card.textContent = content;
  tooltip.append(trigger, card);
  return { tooltip, trigger, card };
}

function createProvider() {
  return document.createElement("openclaw-tooltip-provider") as TooltipProviderElement;
}

function focusTrigger(trigger: HTMLElement) {
  trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
}

function dispatchMousePointer(
  target: EventTarget,
  type: "pointerenter" | "pointerleave" | "pointerover" | "pointerdown",
) {
  const event = new MouseEvent(type, { bubbles: true, composed: true, buttons: 0 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

function dispatchTouchPointer(target: EventTarget, type: "pointerdown" | "pointerup") {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  target.dispatchEvent(event);
}

function hoverTrigger(trigger: HTMLElement) {
  dispatchMousePointer(trigger, "pointerenter");
}

function webAwesomeTooltip(tooltip: TooltipElement) {
  return tooltip.shadowRoot?.querySelector<
    HTMLElement & {
      anchor: Element | null;
      open: boolean;
      readonly updateComplete: Promise<boolean>;
    }
  >("wa-tooltip");
}

function expectOpenCount(count: number) {
  const open = [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")].filter(
    (tooltip) => webAwesomeTooltip(tooltip)?.open,
  );
  expect(open).toHaveLength(count);
}

describe("openclaw-tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reattaches trigger listeners after reconnect", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Reconnect tooltip");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(1);

    provider.remove();
    expectOpenCount(0);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(1);
  });

  it("keeps show reentry idempotent", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Single portal");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    focusTrigger(trigger);

    expectOpenCount(1);
    expect(webAwesomeTooltip(tooltip)?.querySelector(".tooltip-content")?.textContent).toBe(
      "Single portal",
    );
  });

  it("skins the body and removes the arrow through shared overlay tokens", async () => {
    const { tooltip } = createTooltip("Styled tooltip");
    document.body.append(tooltip);
    await tooltip.updateComplete;

    const styles = [...(tooltip.shadowRoot?.querySelectorAll("style") ?? [])]
      .map((style) => style.textContent)
      .join("\n");
    expect(styles).toContain("--wa-tooltip-background-color:");
    expect(styles).toContain("--wa-tooltip-border-color:");
    expect(styles).toContain("--wa-tooltip-border-width: 1px");
    expect(styles).toContain("--wa-tooltip-border-style: solid");
    expect(styles).toContain("--wa-tooltip-arrow-size: var(--openclaw-tooltip-arrow-size, 0px)");
    expect(styles).toContain("var(--overlay-border, var(--border-strong))");
    expect(styles).toContain("var(--overlay-shadow, var(--shadow-md))");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("animation: none");
  });

  it("projects rich content into the Web Awesome tooltip", async () => {
    const { tooltip, trigger, card } = createRichTooltip("Rich card", "Rich card");
    document.body.append(tooltip);
    await tooltip.updateComplete;

    const contentSlot =
      webAwesomeTooltip(tooltip)?.querySelector<HTMLSlotElement>('slot[name="content"]');
    expect(contentSlot?.assignedElements()).toEqual([card]);

    focusTrigger(trigger);
    expectOpenCount(1);
  });

  it("anchors the Web Awesome popup after its initial update", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Anchored tooltip");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;
    await webAwesomeTooltip(tooltip)?.updateComplete;

    expect(webAwesomeTooltip(tooltip)?.anchor).toBe(trigger);
  });

  it("recognizes an HTML trigger created by another document realm", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignDocument = frame.contentDocument;
    if (!foreignDocument) {
      throw new Error("Expected iframe document");
    }
    const tooltip = document.createElement("openclaw-tooltip") as TooltipElement;
    tooltip.content = "Cross-realm tooltip";
    const trigger = foreignDocument.createElement("button");
    trigger.textContent = "trigger";
    tooltip.append(trigger);
    document.body.append(tooltip);
    await tooltip.updateComplete;

    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("restores the normal hover delay after the provider reconnects", async () => {
    const provider = createProvider();
    provider.delay = 40;
    const { tooltip, trigger } = createTooltip("Delayed after reconnect");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(1);
    provider.remove();
    expectOpenCount(0);

    document.body.append(provider);
    await tooltip.updateComplete;
    hoverTrigger(trigger);
    vi.advanceTimersByTime(39);
    expectOpenCount(0);
    vi.advanceTimersByTime(1);
    expectOpenCount(1);
  });

  it("suppresses repeated trigger text before opening and after content updates", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "Claude Opus 4.7 Anthropic");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(0);
    hoverTrigger(trigger);
    vi.runAllTimers();
    expectOpenCount(0);

    tooltip.content = "Additional model details";
    await tooltip.updateComplete;
    focusTrigger(trigger);
    expectOpenCount(1);

    tooltip.content = "Claude Opus 4.7";
    await tooltip.updateComplete;
    expectOpenCount(0);
  });

  it("keeps a repeated-label tooltip when the trigger clips its text", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "Claude Opus 4.7 Anthropic");
    Object.defineProperty(trigger, "scrollWidth", { value: 160, configurable: true });
    Object.defineProperty(trigger, "clientWidth", { value: 80, configurable: true });
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(1);
  });

  it("keeps a repeated-label tooltip with an explicit overflow marker", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "Claude Opus 4.7 Anthropic");
    trigger.setAttribute("data-tooltip-overflow", "");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(1);
  });

  it("keeps a repeated-label tooltip when a nested label clips", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "");
    const label = document.createElement("span");
    label.textContent = "Claude Opus 4.7 Anthropic";
    Object.defineProperty(label, "scrollWidth", { value: 160, configurable: true });
    Object.defineProperty(label, "clientWidth", { value: 80, configurable: true });
    trigger.append(label);
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(1);
  });

  it("does not reopen from pointer-origin focus after activation settles", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Pointer tooltip");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectOpenCount(1);
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    trigger.dispatchEvent(pointerDown);
    trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    trigger.click();
    focusTrigger(trigger);

    expectOpenCount(0);

    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    focusTrigger(trigger);
    expectOpenCount(1);
  });

  it("keeps touch hints explicit through open-on-click", async () => {
    const provider = createProvider();
    const action = createTooltip("Action tooltip");
    const reveal = createTooltip("Reveal tooltip");
    reveal.tooltip.openOnClick = true;
    provider.append(action.tooltip, reveal.tooltip);
    document.body.append(provider);
    await Promise.all([action.tooltip.updateComplete, reveal.tooltip.updateComplete]);

    dispatchTouchPointer(action.trigger, "pointerdown");
    vi.advanceTimersByTime(450);
    expectOpenCount(0);

    dispatchTouchPointer(reveal.trigger, "pointerdown");
    dispatchTouchPointer(reveal.trigger, "pointerup");
    reveal.trigger.click();
    expectOpenCount(1);
  });

  it("pins reveal-only hints until toggled, dismissed, or replaced", async () => {
    const provider = createProvider();
    const reveal = createRichTooltip("Message context");
    const action = createTooltip("Reply");
    const outside = document.createElement("button");
    reveal.tooltip.openOnClick = true;
    provider.append(reveal.tooltip, action.tooltip, outside);
    document.body.append(provider);
    await Promise.all([reveal.tooltip.updateComplete, action.tooltip.updateComplete]);

    hoverTrigger(reveal.trigger);
    vi.advanceTimersByTime(150);
    dispatchMousePointer(reveal.trigger, "pointerdown");
    reveal.trigger.click();
    dispatchMousePointer(reveal.trigger, "pointerleave");
    vi.advanceTimersByTime(500);
    expectOpenCount(1);

    dispatchMousePointer(reveal.trigger, "pointerdown");
    reveal.trigger.click();
    expectOpenCount(0);

    reveal.trigger.click();
    await webAwesomeTooltip(reveal.tooltip)?.updateComplete;
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expectOpenCount(0);
    expect(escape.defaultPrevented).toBe(true);
    await webAwesomeTooltip(reveal.tooltip)?.updateComplete;

    reveal.trigger.click();
    dispatchMousePointer(outside, "pointerdown");
    expectOpenCount(0);

    reveal.trigger.click();
    focusTrigger(action.trigger);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    focusTrigger(action.trigger);
    expect(webAwesomeTooltip(action.tooltip)?.open).toBe(true);
    expect(webAwesomeTooltip(reveal.tooltip)?.open).toBe(false);
  });

  it("keeps portaled and provider-scoped tooltips mutually exclusive", async () => {
    const provider = createProvider();
    const scoped = createTooltip("Reply");
    const portaled = createTooltip("Menu action");
    provider.append(scoped.tooltip);
    document.body.append(provider, portaled.tooltip);
    await Promise.all([scoped.tooltip.updateComplete, portaled.tooltip.updateComplete]);

    hoverTrigger(scoped.trigger);
    vi.advanceTimersByTime(150);
    expect(webAwesomeTooltip(scoped.tooltip)?.open).toBe(true);
    hoverTrigger(portaled.trigger);
    vi.advanceTimersByTime(150);
    expect(webAwesomeTooltip(portaled.tooltip)?.open).toBe(true);
    expect(webAwesomeTooltip(scoped.tooltip)?.open).toBe(false);
    hoverTrigger(scoped.trigger);
    vi.advanceTimersByTime(150);
    expect(webAwesomeTooltip(portaled.tooltip)?.open).toBe(false);
    expect(webAwesomeTooltip(scoped.tooltip)?.open).toBe(true);
  });

  it("consumes only an unclaimed Escape while a tooltip is active", async () => {
    const { tooltip, trigger } = createTooltip("Keyboard hint");
    document.body.append(tooltip);
    await tooltip.updateComplete;
    focusTrigger(trigger);
    const downstream = vi.fn();
    trigger.addEventListener("keydown", downstream);
    const descriptionId = trigger.getAttribute("aria-describedby");

    for (const key of ["Tab", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      if (key === "Escape") {
        event.preventDefault();
      }
      trigger.dispatchEvent(event);
      expectOpenCount(1);
    }
    expect(downstream).toHaveBeenCalledTimes(2);

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    trigger.dispatchEvent(escape);
    expectOpenCount(0);
    expect(escape.defaultPrevented).toBe(true);
    expect(downstream).toHaveBeenCalledTimes(2);
    expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe("Keyboard hint");

    const nextEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    trigger.dispatchEvent(nextEscape);
    expect(nextEscape.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledTimes(3);
  });

  it("honors per-tooltip hover intent while keyboard focus stays immediate", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createRichTooltip("Intentional hovercard");
    tooltip.delay = 600;
    tooltip.closeDelay = 300;
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    hoverTrigger(trigger);
    vi.advanceTimersByTime(300);
    dispatchMousePointer(trigger, "pointerleave");
    expectOpenCount(0);

    hoverTrigger(trigger);
    vi.advanceTimersByTime(599);
    expectOpenCount(0);
    vi.advanceTimersByTime(1);
    expectOpenCount(1);

    dispatchMousePointer(trigger, "pointerleave");
    vi.advanceTimersByTime(299);
    expectOpenCount(1);
    vi.advanceTimersByTime(1);
    expectOpenCount(0);

    focusTrigger(trigger);
    expectOpenCount(1);

    trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    hoverTrigger(trigger);
    vi.advanceTimersByTime(0);
    expectOpenCount(0);
    dispatchMousePointer(trigger, "pointerleave");
  });

  it("keeps the accessible description in the trigger document tree", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Accessible tooltip");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    const descriptionId = trigger.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe("Accessible tooltip");
  });

  it("describes the focusable element inside a wrapper trigger", async () => {
    const tooltip = document.createElement("openclaw-tooltip") as TooltipElement;
    const row = document.createElement("div");
    const link = document.createElement("a");
    link.href = "#session";
    link.textContent = "Release notes";
    row.append(link);
    const card = document.createElement("div");
    card.slot = "content";
    card.textContent = "Branch feature/sidebar";
    tooltip.append(row, card);
    document.body.append(tooltip);
    await tooltip.updateComplete;

    expect(row.hasAttribute("aria-describedby")).toBe(false);
    const descriptionId = link.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Branch feature/sidebar",
    );
  });

  it("describes rich content with its text content", async () => {
    const { tooltip, trigger } = createRichTooltip("Online 2 Alice Server v2026.7.2");
    document.body.append(tooltip);
    await tooltip.updateComplete;

    const descriptionId = trigger.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Online 2 Alice Server v2026.7.2",
    );
  });

  it("refreshes the rich description when assigned descendants change", async () => {
    const { tooltip, trigger, card } = createRichTooltip("");
    const detail = document.createElement("span");
    detail.textContent = "Initial detail";
    card.append(detail);
    document.body.append(tooltip);
    await tooltip.updateComplete;

    const descriptionId = trigger.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toBe("Initial detail");

    tooltip.remove();
    document.body.append(tooltip);
    await tooltip.updateComplete;
    detail.textContent = "Updated detail";
    await Promise.resolve();
    expect(document.getElementById(descriptionId)?.textContent).toBe("Updated detail");
  });

  it("stays open while focus moves from the trigger into rich content", async () => {
    const { tooltip, trigger, card } = createRichTooltip("Focusable card");
    card.tabIndex = 0;
    const outside = document.createElement("button");
    document.body.append(tooltip, outside);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    trigger.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: card }),
    );
    focusTrigger(card);
    expectOpenCount(1);

    card.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: outside }),
    );
    expectOpenCount(0);
  });

  it("stays open when a focused trigger is swept through and out of rich content", async () => {
    const { tooltip, trigger } = createRichTooltip("Scrollable card");
    document.body.append(tooltip);
    await tooltip.updateComplete;

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    hoverTrigger(trigger);
    const richContent = tooltip.shadowRoot?.querySelector(".tooltip-rich-content");
    dispatchMousePointer(trigger, "pointerleave");
    if (richContent) {
      dispatchMousePointer(richContent, "pointerenter");
      dispatchMousePointer(richContent, "pointerleave");
    }
    vi.advanceTimersByTime(100);

    expect(document.activeElement).toBe(trigger);
    expectOpenCount(1);
  });

  it("closes after pointer leave when nothing retains the rich tooltip", async () => {
    const { tooltip, trigger } = createRichTooltip("Hover-only card");
    document.body.append(tooltip);
    await tooltip.updateComplete;

    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    expectOpenCount(1);

    dispatchMousePointer(trigger, "pointerleave");
    vi.advanceTimersByTime(99);
    expectOpenCount(1);
    vi.advanceTimersByTime(1);
    expectOpenCount(0);
  });

  it("closes on focusout to an outside element when not hovered", async () => {
    const { tooltip, trigger } = createRichTooltip("Focus-only card");
    const outside = document.createElement("button");
    document.body.append(tooltip, outside);
    await tooltip.updateComplete;

    trigger.focus();
    expectOpenCount(1);
    outside.focus();

    expect(document.activeElement).toBe(outside);
    expectOpenCount(0);
  });

  it("releases the active provider reference when an open tooltip is removed", async () => {
    const provider = createProvider();
    provider.delay = 40;
    provider.skipDelay = 20;
    const first = createTooltip("First tooltip");
    provider.append(first.tooltip);
    document.body.append(provider);
    await first.tooltip.updateComplete;

    focusTrigger(first.trigger);
    expectOpenCount(1);
    first.tooltip.remove();
    expectOpenCount(0);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const downstream = vi.fn();
    provider.addEventListener("keydown", downstream);
    provider.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20);

    const second = createTooltip("Second tooltip");
    provider.append(second.tooltip);
    await second.tooltip.updateComplete;
    hoverTrigger(second.trigger);
    vi.advanceTimersByTime(39);
    expectOpenCount(0);
    vi.advanceTimersByTime(1);
    expectOpenCount(1);
  });
});

describe("title tooltips", () => {
  let stopGuard: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    stopGuard = installTitleTooltips(document);
  });

  afterEach(() => {
    stopGuard?.();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("suppresses a redundant title through open shadow DOM until true pointer leave", () => {
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    trigger.title = "GPT-5.6 Sol";
    const label = document.createElement("span");
    label.textContent = "GPT-5.6 Sol";
    trigger.append(label);
    shadowRoot.append(trigger);
    document.body.append(host);

    label.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(trigger.getAttribute("title")).toBe("");
    label.dispatchEvent(new MouseEvent("pointerleave", { composed: true }));
    expect(trigger.getAttribute("title")).toBe("");

    trigger.dispatchEvent(new MouseEvent("pointerleave", { composed: true }));
    expect(trigger.title).toBe("GPT-5.6 Sol");
  });

  it.each([
    {
      name: "contextual",
      title: "GPT-5.6 Sol · Chat only",
      text: "GPT-5.6 Sol",
      prepare: (_trigger: HTMLElement) => undefined,
    },
    {
      name: "icon-only",
      title: "Open settings",
      text: "",
      prepare: (_trigger: HTMLElement) => undefined,
    },
    {
      name: "hidden-only label",
      title: "Open settings",
      text: "Open settings",
      prepare: (trigger: HTMLElement) => {
        trigger.firstElementChild?.setAttribute("hidden", "");
      },
    },
  ])("routes $name titles through the shared tooltip", async ({ title, text, prepare }) => {
    const trigger = document.createElement("button");
    trigger.title = title;
    const label = document.createElement("span");
    label.textContent = text;
    trigger.append(label);
    prepare(trigger);
    document.body.append(trigger);

    label.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(trigger.title).toBe("");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip");
    expect(tooltip).not.toBeNull();
    await tooltip!.updateComplete;
    vi.advanceTimersByTime(150);
    expect(webAwesomeTooltip(tooltip!)?.open).toBe(true);
    expect(tooltip!.content).toBe(title);
  });

  it("shares delay and exclusivity with explicit tooltips without moving titled nodes", async () => {
    const provider = createProvider();
    provider.delay = 40;
    const explicit = createTooltip("Reply");
    const trigger = document.createElement("button");
    trigger.title = "Full timestamp";
    trigger.setAttribute("aria-label", "Message timestamp");
    provider.append(explicit.tooltip, trigger);
    document.body.append(provider);
    await explicit.tooltip.updateComplete;

    dispatchMousePointer(trigger, "pointerover");
    const delegated = [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")].find(
      (tooltip) => tooltip !== explicit.tooltip,
    );
    expect(delegated).toBeDefined();
    await delegated!.updateComplete;
    vi.advanceTimersByTime(39);
    expectOpenCount(0);
    vi.advanceTimersByTime(1);
    expectOpenCount(1);
    expect(trigger.parentElement).toBe(provider);
    expect(trigger.getAttribute("aria-label")).toBe("Message timestamp");

    hoverTrigger(explicit.trigger);
    vi.advanceTimersByTime(0);
    expect(webAwesomeTooltip(delegated!)?.open).toBe(false);
    expect(webAwesomeTooltip(explicit.tooltip)?.open).toBe(true);
  });

  it.each(["pointer", "focus"] as const)(
    "yields a %s title tooltip to a rich card without restoring the native title",
    async (input) => {
      const trigger = document.createElement("a");
      trigger.href = "https://example.com/item";
      trigger.title = trigger.href;
      trigger.textContent = "Item";
      document.body.append(trigger);
      const activate = () =>
        input === "pointer" ? dispatchMousePointer(trigger, "pointerover") : focusTrigger(trigger);
      activate();
      const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
      await tooltip.updateComplete;
      vi.advanceTimersByTime(150);
      expectOpenCount(1);

      const hovercard = new PortaledHovercardController(() => hovercard.reset());
      hovercard.markTrigger(trigger);
      await Promise.resolve();
      await tooltip.updateComplete;
      expectOpenCount(1);

      hovercard.mount(trigger, createPortaledHovercard("item-preview", "preview"), "vertical");
      await Promise.resolve();
      await tooltip.updateComplete;
      expectOpenCount(0);
      expect(trigger.title).toBe("");
      activate();
      await tooltip.updateComplete;
      vi.advanceTimersByTime(150);
      expectOpenCount(0);

      hovercard.reset();
      await Promise.resolve();
      await tooltip.updateComplete;
      expectOpenCount(0);
      dispatchMousePointer(trigger, "pointerleave");
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(trigger.title).toBe(trigger.href);
      activate();
      await tooltip.updateComplete;
      vi.advanceTimersByTime(150);
      expectOpenCount(1);
    },
  );

  it("tracks dynamic titles and restores the latest title and accessible name", async () => {
    const trigger = document.createElement("button");
    trigger.title = "Pin widget";
    document.body.append(trigger);
    dispatchMousePointer(trigger, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    expect(tooltip).not.toBeNull();
    await tooltip.updateComplete;
    vi.advanceTimersByTime(150);
    expect(trigger.getAttribute("aria-label")).toBe("Pin widget");

    trigger.title = "Pinned widget";
    await Promise.resolve();
    await tooltip.updateComplete;
    expect(tooltip.content).toBe("Pinned widget");
    expect(trigger.title).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Pinned widget");

    dispatchMousePointer(trigger, "pointerleave");
    expect(trigger.title).toBe("Pinned widget");
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expectOpenCount(0);
  });

  it.each(["", null])("dismisses an active title when it changes to %j", async (title) => {
    const trigger = document.createElement("button");
    trigger.title = "Action unavailable";
    document.body.append(trigger);
    dispatchMousePointer(trigger, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    await tooltip.updateComplete;
    vi.advanceTimersByTime(150);
    expectOpenCount(1);

    if (title === null) {
      trigger.removeAttribute("title");
    } else {
      trigger.title = title;
    }
    await Promise.resolve();
    await tooltip.updateComplete;
    expectOpenCount(0);
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.getAttribute("title")).toBe(title);
    trigger.title = "Action available";
    await Promise.resolve();
    await tooltip.updateComplete;
    expectOpenCount(0);
    dispatchMousePointer(trigger, "pointerleave");
    expect(trigger.getAttribute("title")).toBe("Action available");
    dispatchMousePointer(trigger, "pointerover");
    await tooltip.updateComplete;
    vi.advanceTimersByTime(150);
    expectOpenCount(1);
  });

  it("uses the nearest inherited title through shadow DOM and preserves iframe names", async () => {
    const parent = document.createElement("div");
    parent.title = "Inherited hint";
    const shadow = parent.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    shadow.append(trigger);
    document.body.append(parent);
    focusTrigger(trigger);
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    expect(tooltip).not.toBeNull();
    await tooltip.updateComplete;
    expect(tooltip.content).toBe("Inherited hint");
    expect(webAwesomeTooltip(tooltip)?.open).toBe(true);

    const iframe = document.createElement("iframe");
    iframe.title = "Dashboard document";
    document.body.append(iframe);
    dispatchMousePointer(iframe, "pointerover");
    expect(iframe.title).toBe("Dashboard document");
  });

  it("adapts SVG data hints through the same popup without changing their accessible name", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("data-tooltip", "12 requests");
    rect.setAttribute("aria-label", "12 requests");
    svg.append(rect);
    document.body.append(svg);
    dispatchMousePointer(rect, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    expect(tooltip).not.toBeNull();
    await tooltip.updateComplete;
    await webAwesomeTooltip(tooltip)?.updateComplete;
    vi.advanceTimersByTime(150);
    expect(webAwesomeTooltip(tooltip)?.open).toBe(true);
    expect(webAwesomeTooltip(tooltip)?.anchor).toBe(rect);
    expect(rect.getAttribute("aria-label")).toBe("12 requests");
  });

  it("restores a removed suppressed trigger when hover moves elsewhere", () => {
    const removedTrigger = document.createElement("button");
    removedTrigger.title = "High";
    removedTrigger.textContent = "High";
    document.body.append(removedTrigger);
    removedTrigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(removedTrigger.getAttribute("title")).toBe("");
    removedTrigger.remove();

    const nextTrigger = document.createElement("button");
    nextTrigger.title = "Open settings";
    document.body.append(nextTrigger);
    nextTrigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(removedTrigger.title).toBe("High");
    document.body.append(removedTrigger);
    removedTrigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(removedTrigger.getAttribute("title")).toBe("");
    removedTrigger.dispatchEvent(new MouseEvent("pointerleave", { composed: true }));
    expect(removedTrigger.title).toBe("High");
  });

  it("restores a suppressed title when the app-owned guard is disposed", () => {
    const trigger = document.createElement("button");
    trigger.title = "High";
    trigger.textContent = "High";
    document.body.append(trigger);
    trigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(trigger.getAttribute("title")).toBe("");

    stopGuard?.();
    stopGuard = undefined;

    expect(trigger.title).toBe("High");
  });
});
