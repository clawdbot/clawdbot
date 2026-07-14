/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./tooltip.ts";

type TooltipElement = HTMLElement & {
  content: string;
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

function createProvider() {
  return document.createElement("openclaw-tooltip-provider") as TooltipProviderElement;
}

function focusTrigger(trigger: HTMLElement) {
  trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
}

function hoverTrigger(trigger: HTMLElement) {
  const event = new MouseEvent("pointerenter", { bubbles: true, buttons: 0 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  trigger.dispatchEvent(event);
}

function webAwesomeTooltip(tooltip: TooltipElement) {
  return tooltip.shadowRoot?.querySelector<HTMLElement & { open: boolean }>("wa-tooltip");
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
    expect(webAwesomeTooltip(tooltip)?.textContent).toBe("Single portal");
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

  it("suppresses a tooltip that repeats fully visible trigger text", async () => {
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

  it("does not reopen from pointer-origin focus", async () => {
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
    focusTrigger(trigger);

    expectOpenCount(0);
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
