import { describe, expect, it } from "vitest";
import { formatCronJobKind } from "./job-kind.ts";

describe("formatCronJobKind", () => {
  it.each([
    ["agentTurn", "Agent"],
    ["command", "Command"],
    ["systemEvent", "System event"],
    ["heartbeat", "Heartbeat"],
    ["skillCollectionReview", "Skill review"],
    ["script", "Script"],
  ] as const)("maps %s to canonical label %s", (kind, expected) => {
    expect(formatCronJobKind(kind)).toBe(expected);
  });

  it("capitalizes unknown future kinds so they read legibly", () => {
    expect(formatCronJobKind("weirdThing" as "agentTurn")).toBe("WeirdThing");
    expect(formatCronJobKind("NEW_kind" as "agentTurn")).toBe("NEW_kind");
  });

  it("falls back to empty string when given empty input", () => {
    expect(formatCronJobKind("")).toBe("");
  });
});
