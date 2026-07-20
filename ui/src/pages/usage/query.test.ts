// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildSessionsCsv } from "./query.ts";
import type { UsageSessionEntry } from "./types.ts";

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

  it.each([
    ["equals", "=1+1", "'=1+1"],
    ["plus", "+1+1", "'+1+1"],
    ["minus", "-1+1", "'-1+1"],
    ["at", "@SUM(A1:A2)", "'@SUM(A1:A2)"],
    ["leading whitespace", " \t=1+1", "' \t=1+1"],
    ["fullwidth equals", "\uFF1D1+1", "'\uFF1D1+1"],
    ["fullwidth plus", "\uFF0B1+1", "'\uFF0B1+1"],
    ["fullwidth minus", "\uFF0D1+1", "'\uFF0D1+1"],
    ["fullwidth at", "\uFF20SUM(A1:A2)", "'\uFF20SUM(A1:A2)"],
  ])("neutralizes spreadsheet formula labels with %s prefix", (_name, label, expected) => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label,
        updatedAt: 0,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv).toContain(`session-1,${expected},`);
  });

  it("quotes carriage returns in formula-neutralized labels", () => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label: "\r=1+1",
        updatedAt: 0,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv).toContain('session-1,"\'\r=1+1",');
  });

  it.each([
    ["tab", "\tplain", "\tplain"],
    ["carriage return", "\rplain", '"\rplain"'],
    ["newline", "\nplain", '"\nplain"'],
  ])("preserves benign labels with leading %s", (_name, label, expected) => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label,
        updatedAt: 0,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv).toContain(`session-1,${expected},`);
  });

  it("keeps numeric cells numeric while neutralizing string labels", () => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label: "-remote-label",
        updatedAt: 0,
        usage: {
          durationMs: -1,
          messageCounts: {
            total: -2,
            user: -3,
            assistant: -4,
            toolCalls: -5,
            toolResults: -6,
            errors: -7,
          },
          input: -5,
          output: -6,
          cacheRead: -7,
          cacheWrite: -8,
          totalTokens: -9,
          totalCost: -10,
          inputCost: -11,
          outputCost: -12,
          cacheReadCost: -13,
          cacheWriteCost: -14,
          missingCostEntries: -15,
        },
      } satisfies UsageSessionEntry,
    ]);

    expect(csv).toContain("session-1,'-remote-label,,,");
    expect(csv).toContain(",-1,-2,-7,-5,-5,-6,-7,-8,-9,-10");
  });
});
