import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronListByMissionParams,
  validateCronListParams,
  validateCronRemoveByMissionParams,
} from "../../gateway/protocol/index.js";

const minimalAddParams = {
  name: "daily-summary",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "tick" },
} as const;

describe("cron-to-mission association", () => {
  describe("schema validation", () => {
    it("accepts cron.add with optional missionId", () => {
      expect(
        validateCronAddParams({
          ...minimalAddParams,
          missionId: "mission-abc-123",
        }),
      ).toBe(true);
    });

    it("accepts cron.add without missionId (ad-hoc cron)", () => {
      expect(validateCronAddParams(minimalAddParams)).toBe(true);
    });

    it("accepts cron.add with null missionId (explicitly unassociated)", () => {
      expect(
        validateCronAddParams({
          ...minimalAddParams,
          missionId: null,
        }),
      ).toBe(true);
    });

    it("rejects cron.add with empty string missionId", () => {
      expect(
        validateCronAddParams({
          ...minimalAddParams,
          missionId: "",
        }),
      ).toBe(false);
    });

    it("accepts cron.list with missionId filter", () => {
      expect(
        validateCronListParams({
          missionId: "mission-abc-123",
        }),
      ).toBe(true);
    });

    it("accepts cron.list without missionId (no filter)", () => {
      expect(validateCronListParams({})).toBe(true);
    });
  });

  describe("cron.listByMission validation", () => {
    it("accepts valid missionId", () => {
      expect(validateCronListByMissionParams({ missionId: "mission-abc-123" })).toBe(true);
    });

    it("rejects missing missionId", () => {
      expect(validateCronListByMissionParams({})).toBe(false);
    });

    it("rejects empty string missionId", () => {
      expect(validateCronListByMissionParams({ missionId: "" })).toBe(false);
    });

    it("rejects additional properties", () => {
      expect(
        validateCronListByMissionParams({ missionId: "m1", extra: "nope" }),
      ).toBe(false);
    });
  });

  describe("cron.removeByMission validation", () => {
    it("accepts valid missionId", () => {
      expect(validateCronRemoveByMissionParams({ missionId: "mission-abc-123" })).toBe(true);
    });

    it("rejects missing missionId", () => {
      expect(validateCronRemoveByMissionParams({})).toBe(false);
    });

    it("rejects empty string missionId", () => {
      expect(validateCronRemoveByMissionParams({ missionId: "" })).toBe(false);
    });

    it("rejects additional properties", () => {
      expect(
        validateCronRemoveByMissionParams({ missionId: "m1", extra: "nope" }),
      ).toBe(false);
    });
  });
});
