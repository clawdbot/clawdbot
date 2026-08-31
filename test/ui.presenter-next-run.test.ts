// UI presenter next-run tests cover presenter scheduling output.
import { describe, expect, it } from "vitest";
import { i18n, t } from "../ui/src/i18n/index.ts";
import { formatNextRun } from "../ui/src/lib/presenter.ts";

describe("formatNextRun", () => {
  it("returns localized n/a for nullish values", () => {
    expect(formatNextRun(null)).toBe(t("common.na"));
    expect(formatNextRun(undefined)).toBe(t("common.na"));
  });

  it("includes weekday and relative time", () => {
    const ts = Date.UTC(2026, 1, 23, 15, 0, 0);
    const out = formatNextRun(ts);
    // formatNextRun formats the weekday through i18n.getLocale(); mirror that
    // locale here instead of the ambient host locale so the assertion holds on
    // non-en hosts (e.g. LANG=zh_CN.UTF-8).
    const weekday = new Date(ts).toLocaleDateString(i18n.getLocale(), { weekday: "short" });
    expect(out.slice(0, weekday.length + 2)).toBe(`${weekday}, `);
    expect(out).toContain("(");
    expect(out).toContain(")");
  });
});
