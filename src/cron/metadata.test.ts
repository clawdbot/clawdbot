import { describe, expect, it } from "vitest";
import {
  assertValidCronMetadata,
  normalizeCronTags,
  resolveCronAutomationType,
  resolveCronJobGroup,
} from "./metadata.js";

const job = (overrides: Record<string, unknown> = {}) =>
  ({
    declarationKey: undefined,
    payload: { kind: "agentTurn", message: "check" },
    ...overrides,
  }) as never;

describe("cron metadata", () => {
  it("normalizes tags without changing the first display spelling", () => {
    expect(normalizeCronTags([" GitHub ", "github", "ci", ""])).toEqual(["GitHub", "ci"]);
  });

  it("resolves Gateway-owned jobs to the reserved System group", () => {
    expect(resolveCronJobGroup(job({ payload: { kind: "heartbeat" } }))).toBe("System");
    expect(resolveCronJobGroup(job({ declarationKey: "heartbeat-task:main:abc" }))).toBe(
      "Ungrouped",
    );
    expect(resolveCronJobGroup(job({ group: "Work" }))).toBe("Work");
    expect(resolveCronJobGroup(job())).toBe("Ungrouped");
  });

  it("rejects reserved groups and malformed tag metadata", () => {
    expect(() => assertValidCronMetadata({ group: " system " })).toThrow(/reserved/);
    expect(() => assertValidCronMetadata({ tags: ["ok", "OK"] })).toThrow(/duplicates/);
    expect(() => assertValidCronMetadata({ tags: [" "] })).toThrow(/blank/);
  });

  it("reports the payload kind used by type grouping", () => {
    expect(resolveCronAutomationType(job({ payload: { kind: "command", argv: ["echo"] } }))).toBe(
      "command",
    );
    expect(resolveCronAutomationType(job({ payload: { kind: "future" } }))).toBe("unknown");
  });
});
