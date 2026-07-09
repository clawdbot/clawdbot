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

function createTooltip(content: string) {
  const tooltip = document.createElement("openclaw-tooltip") as TooltipElement;
  tooltip.content = content;
  const trigger = document.createElement("button");
  trigger.textContent = content;
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
  const event = new MouseEvent("pointermove", { bubbles: true, buttons: 0 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  trigger.dispatchEvent(event);
}

function expectPortalCount(count: number) {
  expect(document.body.querySelectorAll(".openclaw-tooltip")).toHaveLength(count);
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
    expectPortalCount(1);

    provider.remove();
    expectPortalCount(0);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectPortalCount(1);
  });

  it("keeps show reentry idempotent", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Single portal");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    focusTrigger(trigger);

    expectPortalCount(1);
    expect(document.body.querySelector(".openclaw-tooltip")?.textContent).toBe("Single portal");
  });

  it("restores the normal hover delay after the provider reconnects", async () => {
    const provider = createProvider();
    provider.delay = 40;
    const { tooltip, trigger } = createTooltip("Delayed after reconnect");
    provider.append(tooltip);
    document.body.append(provider);
    await tooltip.updateComplete;

    focusTrigger(trigger);
    expectPortalCount(1);
    provider.remove();
    expectPortalCount(0);

    document.body.append(provider);
    await tooltip.updateComplete;
    hoverTrigger(trigger);
    vi.advanceTimersByTime(39);
    expectPortalCount(0);
    vi.advanceTimersByTime(1);
    expectPortalCount(1);
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
    expectPortalCount(1);
    first.tooltip.remove();
    expectPortalCount(0);
    vi.advanceTimersByTime(20);

    const second = createTooltip("Second tooltip");
    provider.append(second.tooltip);
    await second.tooltip.updateComplete;
    hoverTrigger(second.trigger);
    vi.advanceTimersByTime(39);
    expectPortalCount(0);
    vi.advanceTimersByTime(1);
    expectPortalCount(1);
  });
});
