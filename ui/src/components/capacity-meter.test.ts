/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { describe, expect, it } from "vitest";
import { workerCapacityPresentation } from "./worker-capacity.ts";

function renderCapacity(params: Parameters<typeof workerCapacityPresentation>[0]) {
  const container = document.createElement("div");
  const capacity = workerCapacityPresentation(params);
  render(capacity?.meter ?? nothing, container);
  return container;
}

describe("worker capacity meter", () => {
  it.each([
    {
      name: "idle",
      available: 8,
      unavailable: false,
      filled: 0,
      tone: "accent",
      label: "0 of 8 slots busy",
    },
    {
      name: "partially occupied",
      available: 5,
      unavailable: false,
      filled: 3,
      tone: "accent",
      label: "3 of 8 slots busy",
    },
    {
      name: "at capacity",
      available: 0,
      unavailable: false,
      filled: 8,
      tone: "warn",
      label: "8 of 8 slots busy",
    },
    {
      name: "offline with a last-known metric",
      available: 5,
      unavailable: true,
      filled: 0,
      tone: "stale",
      label: "Slot utilization unavailable",
    },
    {
      name: "ineligible and saturated",
      available: 0,
      unavailable: true,
      filled: 0,
      tone: "stale",
      label: "Slot utilization unavailable",
    },
  ])(
    "renders $name without reversing free and busy",
    ({ available, unavailable, filled, tone, label }) => {
      const container = renderCapacity({ workerSlots: { total: 8, available }, unavailable });
      const meter = container.querySelector('[role="img"]');
      expect(meter?.getAttribute("aria-label")).toBe(label);
      expect(meter?.classList.contains(`session-context-meter--${tone}`)).toBe(true);
      expect(container.querySelectorAll(".capacity-meter-pips__pip")).toHaveLength(8);
      expect(container.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(filled);
    },
  );

  it.each([
    { total: 12, unavailable: false, pips: 12, width: undefined, tone: "accent" },
    { total: 13, unavailable: false, pips: 0, width: "100%", tone: "warn" },
    { total: 1024, unavailable: false, pips: 0, width: "50%", tone: "accent" },
    { total: 13, unavailable: true, pips: 0, width: "0%", tone: "stale" },
  ])(
    "bounds glyphs for $total slots (unavailable=$unavailable)",
    ({ total, unavailable, pips, width, tone }) => {
      const available = total === 13 ? 0 : total / 2;
      const container = renderCapacity({ workerSlots: { total, available }, unavailable });
      expect(container.querySelectorAll(".capacity-meter-pips__pip")).toHaveLength(pips);
      expect(
        container.querySelector<HTMLElement>(".session-context-meter__fill")?.style.width,
      ).toBe(width);
      expect(
        container
          .querySelector('[role="img"]')
          ?.classList.contains(`session-context-meter--${tone}`),
      ).toBe(true);
      expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
        unavailable
          ? "Slot utilization unavailable"
          : `${total - available} of ${total} slots busy`,
      );
    },
  );

  it.each([
    { capabilities: ["codex.exec-server"], unavailable: false },
    { capabilities: ["codex.exec-server.stdio.v2"], unavailable: false },
    { commands: ["codex.exec-server.stdio.v2"], unavailable: false },
    { capabilities: ["codex.exec-server"], unavailable: true },
  ])("shows a terminal affordance for a slot-less exec host: %j", (params) => {
    const container = renderCapacity(params);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Codex exec");
    expect(container.textContent).toContain("Codex exec");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".capacity-meter-pips, .session-context-meter")).toBeNull();
  });

  it("prefers slots on dual hosts and renders nothing for an unmetered ordinary device", () => {
    const dualHost = renderCapacity({
      workerSlots: { total: 8, available: 5 },
      capabilities: ["codex.exec-server"],
      unavailable: false,
    });
    expect(dualHost.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "3 of 8 slots busy",
    );
    expect(dualHost.textContent).not.toContain("Codex exec");
    for (const unavailable of [false, true]) {
      const unmetered = renderCapacity({ capabilities: ["camera"], unavailable });
      expect(unmetered.querySelector('[role="img"]')).toBeNull();
      expect(unmetered.textContent).toBe("");
    }
  });
});
