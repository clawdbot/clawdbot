/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderCompactionIndicator, renderFallbackIndicator } from "./status-indicators.ts";

describe("chat status indicators", () => {
  it("renders compaction and fallback indicators while they are fresh", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now");
    const renderIndicators = (
      compactionStatus: Parameters<typeof renderCompactionIndicator>[0],
      fallbackStatus: Parameters<typeof renderFallbackIndicator>[0],
    ) => {
      render(
        html`${renderFallbackIndicator(fallbackStatus)}
        ${renderCompactionIndicator(compactionStatus)}`,
        container,
      );
    };

    try {
      nowSpy.mockReturnValue(1_000);
      renderIndicators(
        {
          phase: "active",
          runId: "run-1",
          startedAt: 1_000,
          completedAt: null,
        },
        {
          selected: "fireworks/minimax-m2p5",
          active: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: ["fireworks/minimax-m2p5: rate limit"],
          occurredAt: 900,
        },
      );

      let indicator = container.querySelector(".compaction-indicator--active");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Compacting context...");
      indicator = container.querySelector(".compaction-indicator--fallback");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");

      renderIndicators(
        {
          phase: "complete",
          runId: "run-1",
          startedAt: 900,
          completedAt: 900,
        },
        {
          phase: "cleared",
          selected: "fireworks/minimax-m2p5",
          active: "fireworks/minimax-m2p5",
          previous: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: [],
          occurredAt: 900,
        },
      );
      indicator = container.querySelector(".compaction-indicator--complete");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Context compacted");
      indicator = container.querySelector(".compaction-indicator--fallback-cleared");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");

      nowSpy.mockReturnValue(20_000);
      renderIndicators(
        {
          phase: "complete",
          runId: "run-1",
          startedAt: 0,
          completedAt: 0,
        },
        {
          selected: "fireworks/minimax-m2p5",
          active: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: [],
          occurredAt: 0,
        },
      );
      expect(container.querySelector(".compaction-indicator--fallback")).toBeNull();
      expect(container.querySelector(".compaction-indicator--complete")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
