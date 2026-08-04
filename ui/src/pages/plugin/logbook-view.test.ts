import { render } from "lit";
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getLogbookState } from "./logbook-controller.ts";
import { renderLogbook } from "./logbook-view.ts";

describe("Logbook view", () => {
  it("renders timeline clocks in the capture host timezone", () => {
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

    const timeOptions = {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    } satisfies Intl.DateTimeFormatOptions;
    const expectedTime = [Date.UTC(2026, 0, 2, 0, 30), Date.UTC(2026, 0, 2, 1, 30)]
      .map((ms) => new Date(ms).toLocaleTimeString(i18n.getLocale(), timeOptions))
      .join("–");
    expect(container.querySelector(".logbook-card__time")?.textContent?.trim()).toBe(expectedTime);
    expect(container.querySelector(".logbook-card__duration")?.textContent?.trim()).toBe("1h");
  });
});
