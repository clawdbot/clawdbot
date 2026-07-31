import { describe, expect, it } from "vitest";
import {
  parseSkillProposalRecord,
  parseSkillProposalRollback,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "./store-record.js";
import { SKILL_WORKSHOP_ROLLBACK_SCHEMA, SKILL_WORKSHOP_SCHEMA } from "./types.js";

const shippedProposal = {
  schema: SKILL_WORKSHOP_SCHEMA,
  id: "shipped-workshop-20260729-1234567890",
  kind: "update",
  status: "pending",
  title: "Update shipped-workshop",
  description: "Proposal written by a shipped Workshop release",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  createdBy: "skill-workshop",
  origin: {
    agentId: "main",
    sessionKey: "agent:main:workshop",
    runId: "shipped-run",
  },
  originRunIds: ["shipped-run"],
  originRunMutationCounts: { "shipped-run": 1 },
  proposedVersion: "v1",
  draftFile: "PROPOSAL.md",
  draftHash: "a".repeat(64),
  supportFiles: [
    {
      path: "references/proof.md",
      sizeBytes: 6,
      hash: "b".repeat(64),
      targetExisted: true,
      targetContentHash: "c".repeat(64),
    },
  ],
  target: {
    skillName: "shipped-workshop",
    skillKey: "shipped-workshop",
    skillDir: "/workspace/skills/shipped-workshop",
    skillFile: "/workspace/skills/shipped-workshop/SKILL.md",
    source: "openclaw-workspace",
    currentContentHash: "d".repeat(64),
  },
  scan: {
    state: "clean",
    scannedAt: "2026-07-29T00:00:00.000Z",
    critical: 0,
    warn: 0,
    info: 0,
    findings: [],
  },
  goal: "Preserve existing Workshop behavior.",
  evidence: "Record shape from v2026.7.2-beta.5.",
} as const;

const shippedRollback = {
  schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  proposalId: shippedProposal.id,
  writtenAt: "2026-07-29T00:00:00.000Z",
  targetSkillFile: shippedProposal.target.skillFile,
  action: "update",
  previousContentHash: "e".repeat(64),
  previousContent: "# Previous skill\n",
  supportFiles: [
    {
      path: "references/proof.md",
      existed: true,
      previousContentHash: "f".repeat(64),
      previousContent: "proof\n",
    },
  ],
} as const;

describe("Skill Workshop persisted record validation", () => {
  it("accepts the shipped v1 proposal and rollback shapes unchanged", () => {
    expect(validateSkillProposalRecord(shippedProposal)).toEqual({
      ok: true,
      value: shippedProposal,
    });
    expect(validateSkillProposalRollback(shippedRollback)).toEqual({
      ok: true,
      value: shippedRollback,
    });
    expect(parseSkillProposalRecord(shippedProposal)).toBe(shippedProposal);
    expect(parseSkillProposalRollback(shippedRollback)).toBe(shippedRollback);
  });

  it("maps invalid metadata to the existing migration errors", () => {
    expect(validateSkillProposalRecord({ ...shippedProposal, schema: "invalid" })).toEqual({
      ok: false,
      error: {
        code: "invalid-proposal-metadata",
        message: "invalid proposal metadata",
      },
    });
    expect(validateSkillProposalRollback({ ...shippedRollback, action: "invalid" })).toEqual({
      ok: false,
      error: {
        code: "invalid-rollback-metadata",
        message: "invalid rollback metadata",
      },
    });
  });
});
