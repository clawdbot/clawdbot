// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildUsageHeatmap } from "./heatmap.ts";

const day = (date: string, totalTokens: number) => ({ date, totalTokens });

describe("buildUsageHeatmap", () => {
  it("covers 52 trailing weeks aligned to Sunday columns", () => {
    const heatmap = buildUsageHeatmap([day("2026-07-09", 10)], "2025-07-11", "2026-07-09", "en-US");
    expect(heatmap.weeks.length).toBeGreaterThanOrEqual(52);
    expect(heatmap.weeks.length).toBeLessThanOrEqual(53);
    expect(heatmap.monthLabels.length).toBe(heatmap.weeks.length);

    const lastWeek = heatmap.weeks.at(-1);
    expect(lastWeek?.days[4]?.date).toBe("2026-07-09");
    expect(lastWeek?.days[5]).toBeNull();
    expect(lastWeek?.days[6]).toBeNull();

    const allDays = heatmap.weeks.flatMap((week) => week.days).filter(Boolean);
    expect(allDays.length).toBe(52 * 7);
    expect(allDays[0]?.date).toBe("2025-07-11");
  });

  it("buckets nonzero days into quartile levels and zero days to level 0", () => {
    const daily = [
      day("2026-07-05", 0),
      day("2026-07-06", 10),
      day("2026-07-07", 20),
      day("2026-07-08", 30),
      day("2026-07-09", 40),
    ];
    const heatmap = buildUsageHeatmap(daily, "2026-07-05", "2026-07-09", "en-US");
    const byDate = new Map(
      heatmap.weeks
        .flatMap((week) => week.days)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .map((entry) => [entry.date, entry]),
    );
    expect(byDate.get("2026-07-05")?.level).toBe(0);
    expect(byDate.get("2026-07-06")?.level).toBe(1);
    expect(byDate.get("2026-07-07")?.level).toBe(2);
    expect(byDate.get("2026-07-08")?.level).toBe(3);
    expect(byDate.get("2026-07-09")?.level).toBe(4);
    expect(byDate.has("2026-01-01")).toBe(false);
  });

  it("labels a column when a new month starts", () => {
    const heatmap = buildUsageHeatmap([], "2025-07-11", "2026-07-09", "en-US");
    const labels = heatmap.monthLabels.filter(Boolean);
    expect(labels.length).toBeGreaterThanOrEqual(12);
    expect(heatmap.monthLabels[0]).not.toBe("");
  });

  it("caps all-time ranges to the trailing year ending at the selected date", () => {
    const heatmap = buildUsageHeatmap([], "1970-01-01", "2026-07-09", "en-US");
    const allDays = heatmap.weeks.flatMap((week) => week.days).filter(Boolean);
    expect(allDays).toHaveLength(52 * 7);
    expect(allDays[0]?.date).toBe("2025-07-11");
    expect(allDays.at(-1)?.date).toBe("2026-07-09");
  });

  it("labels a padded week from its first visible day", () => {
    const heatmap = buildUsageHeatmap([day("2026-08-01", 10)], "2026-08-01", "2026-08-01", "en-US");
    expect(heatmap.monthLabels).toEqual(["Aug"]);
  });
});
