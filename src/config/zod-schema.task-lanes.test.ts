// Covers the taskLanes config schema: strict entries, id pattern, required paths.
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const MINIMAL_ENTRY = {
  id: "release-board",
  rootDir: "/srv/lanes",
  filePath: "board.json",
};

function parseTaskLanes(taskLanes: unknown) {
  return OpenClawSchema.safeParse({ taskLanes });
}

describe("OpenClawSchema taskLanes", () => {
  it("accepts a minimal provider entry", () => {
    const result = parseTaskLanes({ providers: [MINIMAL_ENTRY] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskLanes?.providers).toEqual([MINIMAL_ENTRY]);
    }
  });

  it("accepts the section being absent or empty", () => {
    expect(OpenClawSchema.safeParse({}).success).toBe(true);
    expect(parseTaskLanes({}).success).toBe(true);
    expect(parseTaskLanes({ providers: [] }).success).toBe(true);
  });

  it("rejects ids outside the task-lane provider id pattern", () => {
    for (const id of ["A-board", "-board", "a board", "a".repeat(65), ""]) {
      expect(
        parseTaskLanes({ providers: [{ ...MINIMAL_ENTRY, id }] }).success,
        `id ${JSON.stringify(id)}`,
      ).toBe(false);
    }
  });

  it("rejects missing or empty required paths", () => {
    for (const entry of [
      { id: "release-board", rootDir: "/srv/lanes" },
      { id: "release-board", filePath: "board.json" },
      { id: "release-board", rootDir: "/srv/lanes", filePath: "" },
    ]) {
      expect(parseTaskLanes({ providers: [entry] }).success).toBe(false);
    }
  });

  it("rejects unknown fields inside a provider entry", () => {
    expect(parseTaskLanes({ providers: [{ ...MINIMAL_ENTRY, readOnly: true }] }).success).toBe(
      false,
    );
  });

  it("rejects duplicate provider ids", () => {
    const result = parseTaskLanes({ providers: [MINIMAL_ENTRY, MINIMAL_ENTRY] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("duplicate task lane provider id"),
        ),
      ).toBe(true);
    }
  });
});
