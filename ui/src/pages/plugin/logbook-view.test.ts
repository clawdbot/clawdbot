import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { setUiTimeFormatPreference } from "../../lib/format.ts";
import { getLogbookState } from "./logbook-controller.ts";
import { renderLogbook } from "./logbook-view.ts";

describe("Logbook view", () => {
  afterEach(() => {
    setUiTimeFormatPreference("auto");
  });

  it("renders timeline clocks in the capture host timezone", () => {
    setUiTimeFormatPreference("24");
    const host = {};
    const state = getLogbookState(host);
    state.day = "2026-01-01";
    state.status = {
      captureEnabled: true,
      capturePaused: false,
      captureIntervalSeconds: 30,
      analysisIntervalMinutes: 15,
      retentionDays: 30,
      pendingFrames: 0,
      analysisRunning: false,
      visionModelSource: "missing",
      today: "2026-01-01",
      todayCards: 1,
      timeZone: "America/Los_Angeles",
    };
    state.timeline = {
      day: state.day,
      cards: [
        {
          id: 1,
          day: state.day,
          startMs: Date.UTC(2026, 0, 2, 0, 30),
          endMs: Date.UTC(2026, 0, 2, 1, 30),
          title: "Work",
          summary: "Summary",
          detail: "",
          category: "Coding",
          distractions: [],
        },
      ],
      stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
    };

    const container = document.createElement("div");
    render(renderLogbook({ host, client: null, connected: false }), container);

    expect(container.querySelector(".logbook-card__time")?.textContent?.trim()).toBe("16:30–17:30");
    expect(container.querySelector(".logbook-card__duration")?.textContent?.trim()).toBe("1h");
  });
});
