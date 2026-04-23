import { describe, expect, it } from "vitest";
import { t } from "../ui/src/i18n/index.ts";
import { formatNextRun } from "../ui/src/ui/presenter.ts";

describe("formatNextRun", () => {
  it("returns localized n/a for nullish values", () => {
    expect(formatNextRun(null)).toBe(t("common.na"));
    expect(formatNextRun(undefined)).toBe(t("common.na"));
  });

  it("includes weekday and relative time", () => {
    const ts = Date.UTC(2026, 1, 23, 15, 0, 0);
    const out = formatNextRun(ts);
    const weekday = new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
    expect(out.slice(0, weekday.length + 2)).toBe(`${weekday}, `);
    expect(out).toContain("(");
    expect(out).toContain(")");
  });
});
