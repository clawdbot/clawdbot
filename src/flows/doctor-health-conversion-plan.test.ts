import { describe, expect, it } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.js";
import { doctorHealthConversionRules } from "./doctor-health-conversion-plan.js";

describe("doctor health conversion plan", () => {
  it("classifies every current run contribution", () => {
    const contributionIds = resolveDoctorHealthContributions().map(
      (contribution) => contribution.id,
    );
    const plannedIds = doctorHealthConversionRules.map((rule) => rule.contributionId);

    expect(plannedIds).toEqual(contributionIds);
  });

  it("keeps conversion targets explicit", () => {
    for (const rule of doctorHealthConversionRules) {
      expect(rule.target.length).toBeGreaterThan(0);
      expect(rule.rule.trim()).not.toBe("");
    }
  });

  it("wires contributions only to registered core health check targets", () => {
    const contributions = new Map(
      resolveDoctorHealthContributions().map((contribution) => [contribution.id, contribution]),
    );
    const registeredCoreIds = new Set(CORE_HEALTH_CHECKS.map((check) => check.id));

    for (const rule of doctorHealthConversionRules) {
      const contribution = contributions.get(rule.contributionId);
      expect(contribution).toBeDefined();
      for (const id of contribution?.healthCheckIds ?? []) {
        expect(rule.target).toContain(id);
        expect(registeredCoreIds.has(id)).toBe(true);
      }
    }
  });
});
