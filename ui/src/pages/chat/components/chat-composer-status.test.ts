import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import type { CompactionStatus } from "../tool-stream-contract.ts";
import { renderCompactionIndicator, renderFallbackIndicator } from "./chat-composer-status.ts";

describe("chat composer status localization", () => {
  let container: HTMLDivElement;
  let restoreI18nState: () => Promise<void>;

  beforeEach(async () => {
    restoreI18nState = captureI18nStateForTesting();
    await i18n.setLocale("de");
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await restoreI18nState();
    vi.restoreAllMocks();
    container.remove();
  });

  it.each(["active", "retrying"] as const)(
    "announces localized %s compaction without exposing the decorative glyph",
    (phase) => {
      render(
        renderCompactionIndicator({
          phase,
          runId: "run-1",
          startedAt: 1_000,
          completedAt: null,
        }),
        container,
      );
      const status = container.querySelector(".compaction-indicator--active");
      expect(status?.getAttribute("role")).toBe("status");
      expect(status?.getAttribute("aria-live")).toBe("polite");
      expect(status?.textContent?.trim()).toBe("Kontext wird komprimiert...");
      const glyph = status?.querySelector(".compaction-indicator__glyph");
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(glyph?.textContent?.trim()).toBe("");
    },
  );

  it("retains the glyph and its children through retry and completion for the transition", () => {
    const status: CompactionStatus = {
      phase: "active",
      runId: "run-1",
      startedAt: 1_000,
      completedAt: null,
    };
    render(renderCompactionIndicator(status), container);
    const indicator = container.querySelector(".compaction-indicator");
    const glyph = container.querySelector(".compaction-indicator__glyph");
    expect(glyph).not.toBeNull();
    const children = Array.from(glyph!.children);
    expect(children.length).toBeGreaterThan(0);

    for (const phase of ["retrying", "complete"] as const) {
      render(
        renderCompactionIndicator({
          ...status,
          phase,
          completedAt: phase === "complete" ? 1_000 : null,
        }),
        container,
      );
      expect(container.querySelector(".compaction-indicator")).toBe(indicator);
      expect(container.querySelector(".compaction-indicator__glyph")).toBe(glyph);
      expect(glyph!.children).toHaveLength(children.length);
      children.forEach((child, index) => expect(glyph!.children[index]).toBe(child));
    }
    expect(indicator?.classList.contains("compaction-indicator--complete")).toBe(true);
    expect(indicator?.getAttribute("role")).toBe("status");
    expect(indicator?.getAttribute("aria-live")).toBe("polite");
    expect(indicator?.textContent?.trim()).toBe("Kontext komprimiert");
  });

  it("removes completed feedback at the five-second boundary on rerender", () => {
    const status: CompactionStatus = {
      phase: "complete",
      runId: "run-1",
      startedAt: 900,
      completedAt: 1_000,
    };
    vi.mocked(Date.now).mockReturnValue(5_999);
    render(renderCompactionIndicator(status), container);
    expect(container.querySelector("[role='status']")?.textContent?.trim()).toBe(
      "Kontext komprimiert",
    );
    vi.mocked(Date.now).mockReturnValue(6_000);
    render(renderCompactionIndicator(status), container);
    expect(container.childElementCount).toBe(0);
  });

  it.each<{ name: string; status: CompactionStatus | null | undefined }>([
    { name: "null status", status: null },
    { name: "undefined status", status: undefined },
    {
      name: "completion without a timestamp",
      status: { phase: "complete", runId: "run-1", startedAt: 900, completedAt: null },
    },
  ])("clears a rendered indicator for $name", ({ status }) => {
    render(
      renderCompactionIndicator({
        phase: "active",
        runId: "run-1",
        startedAt: 1_000,
        completedAt: null,
      }),
      container,
    );
    expect(container.querySelector("[role='status']")).not.toBeNull();
    render(renderCompactionIndicator(status), container);
    expect(container.childElementCount).toBe(0);
  });

  it("renders translated fallback status", () => {
    render(
      renderFallbackIndicator({
        selected: "provider/selected",
        active: "provider/active",
        attempts: ["provider/selected: rate limit"],
        occurredAt: 900,
      }),
      container,
    );
    const fallback = container.querySelector(".compaction-indicator--fallback");
    expect(fallback?.textContent?.trim()).toBe("Fallback aktiv: provider/active");
    expect(fallback?.getAttribute("aria-label")).toBe(
      "Ausgewählt: provider/selected • Aktiv: provider/active • Versuche: provider/selected: rate limit",
    );
  });
});
