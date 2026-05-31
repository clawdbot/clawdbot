// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildSessionsCsv } from "./usage-query.ts";
import type { UsageSessionEntry } from "./usageTypes.ts";

describe("usage query CSV export", () => {
  it("omits invalid session updated timestamps instead of throwing", () => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label: "Session 1",
        updatedAt: Number.POSITIVE_INFINITY,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv).toContain("session-1,Session 1,,,,,,,,,,,,,,,");
  });
});
