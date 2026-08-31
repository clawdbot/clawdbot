import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SkillsProposalActionParamsSchema,
  SkillsProposalDecisionParamsSchema,
  SkillsProposalRequestRevisionParamsSchema,
} from "./agents-models-skills.js";

describe("Skill Workshop revision-bound request schemas", () => {
  it("requires exact revision hashes for operator decisions and natural revisions", () => {
    const decision = { proposalId: "proposal-1", expectedRevisionHash: "a".repeat(64) };

    expect(Value.Check(SkillsProposalDecisionParamsSchema, decision)).toBe(true);
    expect(Value.Check(SkillsProposalDecisionParamsSchema, { proposalId: "proposal-1" })).toBe(
      false,
    );
    expect(Value.Check(SkillsProposalActionParamsSchema, { proposalId: "proposal-1" })).toBe(true);
    expect(
      Value.Check(SkillsProposalRequestRevisionParamsSchema, {
        ...decision,
        instructions: "Revise the draft",
        sessionKey: "agent:main:revision",
        idempotencyKey: "revision-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(SkillsProposalRequestRevisionParamsSchema, {
        proposalId: "proposal-1",
        instructions: "Revise the draft",
        sessionKey: "agent:main:revision",
        idempotencyKey: "revision-1",
      }),
    ).toBe(false);
  });
});
