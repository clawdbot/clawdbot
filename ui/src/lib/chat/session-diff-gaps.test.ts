import { describe, expect, it } from "vitest";
import { expandSessionDiffGap } from "./session-diff-gaps.ts";
import type { DiffLine, DiffLineGap } from "./tool-call-diff.ts";

const formatGap = (count: number) => `${count} unmodified lines`;
const gap: DiffLineGap = { oldStart: 1, newStart: 1, count: 50 };
const fileLines = Array.from({ length: 52 }, (_, index) => `line ${index + 1}`);
const lines: DiffLine[] = [
  { kind: "skip", text: formatGap(gap.count), gap },
  { kind: "ctx", lineNo: 51, text: "line 51" },
  { kind: "add", lineNo: 52, text: "line 52" },
];

describe("expandSessionDiffGap", () => {
  it.each([
    {
      direction: "down" as const,
      contextStart: 1,
      contextEnd: 20,
      marker: { oldStart: 21, newStart: 21, count: 30 },
      markerIndex: 20,
    },
    {
      direction: "up" as const,
      contextStart: 31,
      contextEnd: 50,
      marker: { oldStart: 1, newStart: 1, count: 30 },
      markerIndex: 0,
    },
  ])(
    "reveals a continuous $direction chunk and shrinks the marker",
    ({ direction, contextStart, contextEnd, marker, markerIndex }) => {
      const expanded = expandSessionDiffGap(lines, gap, fileLines, direction, formatGap);

      expect(expanded?.[markerIndex]).toMatchObject({ kind: "skip", gap: marker });
      const context = expanded?.filter((line) => line.kind === "ctx" && (line.lineNo ?? 0) <= 50);
      expect(context?.at(0)).toEqual({
        kind: "ctx",
        lineNo: contextStart,
        text: `line ${contextStart}`,
      });
      expect(context?.at(-1)).toEqual({
        kind: "ctx",
        lineNo: contextEnd,
        text: `line ${contextEnd}`,
      });
    },
  );

  it("reveals the full gap with continuous new-side line numbers", () => {
    const expanded = expandSessionDiffGap(lines, gap, fileLines, "all", formatGap);

    expect(expanded?.some((line) => line.kind === "skip")).toBe(false);
    expect(expanded?.map((line) => line.lineNo)).toEqual(
      Array.from({ length: 52 }, (_, index) => index + 1),
    );
  });

  it.each(["down", "up", "all"] as const)(
    "reveals a gap of 25 lines or fewer in one %s click",
    (direction) => {
      const smallGap: DiffLineGap = { oldStart: 1, newStart: 1, count: 25 };
      const smallLines: DiffLine[] = [
        { kind: "skip", text: formatGap(smallGap.count), gap: smallGap },
      ];
      const expanded = expandSessionDiffGap(smallLines, smallGap, fileLines, direction, formatGap);

      expect(expanded).toHaveLength(25);
      expect(expanded?.some((line) => line.kind === "skip")).toBe(false);
    },
  );

  it("leaves the marker unchanged when working-tree content no longer matches the patch", () => {
    const staleLines = fileLines.with(50, "changed since diff");
    expect(expandSessionDiffGap(lines, gap, staleLines, "down", formatGap)).toBeNull();
  });
});
