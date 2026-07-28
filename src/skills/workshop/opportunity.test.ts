import { describe, expect, it } from "vitest";
import {
  buildSkillOpportunityContext,
  buildSkillOpportunityIdempotencyKey,
  SKILL_OPPORTUNITY_APPROVAL_BOUNDARY,
  SKILL_OPPORTUNITY_MARKER,
} from "./opportunity.js";

describe("skill opportunity contract", () => {
  it("derives a stable bounded idempotency key from the candidate and signal context", () => {
    const first = buildSkillOpportunityIdempotencyKey({
      candidateSkillName: "GitHub PR Workflow",
      triggerHash: "signal-123",
      context: "repeatable review flow",
    });
    const equivalent = buildSkillOpportunityIdempotencyKey({
      candidateSkillName: " github   pr workflow ",
      triggerHash: "SIGNAL-123",
      context: "Repeatable review flow",
    });
    const different = buildSkillOpportunityIdempotencyKey({
      candidateSkillName: "GitHub PR Workflow",
      triggerHash: "signal-456",
      context: "repeatable review flow",
    });

    expect(first).toBe(equivalent);
    expect(first).toMatch(/^skill-opportunity-v1:[0-9a-f]{32}$/);
    expect(different).not.toBe(first);
  });

  it("renders an obvious recommendation and a generic durable-capture boundary", () => {
    const text = buildSkillOpportunityContext({
      candidateSkillName: "github-pr-workflow",
      observedWorkflow: "Repeated PR review preparation",
      expectedBenefit: "Avoid repeating the review checklist",
      evidence: "The same workflow was requested several times",
      opportunityKey: "skill-opportunity-v1:abc123",
      source: "skill_workshop",
      proposalId: "proposal-123",
    });

    expect(text).toContain(SKILL_OPPORTUNITY_MARKER);
    expect(text).toContain("Candidate skill: github-pr-workflow");
    expect(text).toContain("Observed recurring workflow/problem: Repeated PR review preparation");
    expect(text).toContain("Opportunity idempotency key: skill-opportunity-v1:abc123");
    expect(text).toContain("Source: skill_workshop");
    expect(text).toContain("Pending Skill Workshop proposal: proposal-123");
    expect(text).toContain(
      "Optional extension capture: an enabled extension may use this idempotency key",
    );
    expect(text).not.toContain("workboard_create");
    expect(text).toContain(SKILL_OPPORTUNITY_APPROVAL_BOUNDARY);

    const legacyText = buildSkillOpportunityContext({
      candidateSkillName: "legacy-workflow",
    });
    expect(legacyText).toContain(
      "Optional extension capture: [blocked] deterministic idempotency key unavailable",
    );
    expect(legacyText).not.toContain("workboard_create");
  });
});
