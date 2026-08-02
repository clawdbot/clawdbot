import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { renderCompactionIndicator, renderFallbackIndicator } from "./chat-composer-status.ts";

describe("chat composer status localization", () => {
  beforeEach(async () => {
    i18n.registerTranslation("de", {
      chat: {
        composer: {
          compactingContext: "Kontext wird komprimiert...",
          fallbackActive: "Ausweichmodell aktiv: {model}",
          fallbackSelected: "Ausgewählt: {model}",
          fallbackCurrent: "Aktiv: {model}",
          fallbackAttempts: "Versuche: {attempts}",
        },
      },
    });
    await i18n.setLocale("de");
    vi.spyOn(Date, "now").mockReturnValue(1_000);
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders translated compaction and fallback status", () => {
    render(
      renderCompactionIndicator({
        phase: "active",
        runId: "run-1",
        startedAt: 1_000,
        completedAt: null,
      }),
      document.body,
    );
    expect(document.querySelector(".compaction-indicator")?.textContent?.trim()).toBe(
      "Kontext wird komprimiert...",
    );

    render(
      renderFallbackIndicator({
        selected: "provider/selected",
        active: "provider/active",
        attempts: ["provider/selected: rate limit"],
        occurredAt: 900,
      }),
      document.body,
    );
    const fallback = document.querySelector(".compaction-indicator--fallback");
    expect(fallback?.textContent?.trim()).toBe("Ausweichmodell aktiv: provider/active");
    expect(fallback?.getAttribute("aria-label")).toBe(
      "Ausgewählt: provider/selected • Aktiv: provider/active • Versuche: provider/selected: rate limit",
    );
  });
});
