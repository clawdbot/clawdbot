import { describe, expect, it } from "vitest";
import {
  nextProposalVersion,
  prepareSkillProposalDraft,
  resolveUpdateProposalDescription,
} from "./proposal-draft.js";

describe("Skill Workshop proposal draft preparation", () => {
  it("normalizes one canonical draft result for create and revise callers", () => {
    const prepared = prepareSkillProposalDraft({
      name: "release-check",
      description: "Check a release",
      content: "# Release Check\n",
      date: "2026-07-29T00:00:00.000Z",
      maxSkillBytes: 1024,
      supportFiles: [{ path: "references/checklist.md", content: "Verify artifacts.\n" }],
      goal: "  Preserve release quality.  ",
      evidence: "  Existing operator checklist.  ",
    });

    expect(prepared).toMatchObject({
      ok: true,
      value: {
        description: "Check a release",
        goal: "Preserve release quality.",
        evidence: "Existing operator checklist.",
        scan: { state: "clean", critical: 0 },
        supportFiles: [
          expect.objectContaining({
            path: "references/checklist.md",
            content: "Verify artifacts.\n",
          }),
        ],
      },
    });
    if (!prepared.ok) {
      throw prepared.error.cause;
    }
    expect(prepared.value.content).toContain('name: "release-check"');
    expect(prepared.value.content).toContain('date: "2026-07-29T00:00:00.000Z"');
    expect(prepared.value.draftHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the existing validation messages without persisting partial output", () => {
    const oversized = prepareSkillProposalDraft({
      name: "release-check",
      description: "Check a release",
      content: "x".repeat(5),
      date: "2026-07-29T00:00:00.000Z",
      maxSkillBytes: 4,
    });
    expect(oversized).toMatchObject({
      ok: false,
      error: {
        message: "Skill proposal content is too large (5 bytes, max 4).",
      },
    });

    const secret = prepareSkillProposalDraft({
      name: "release-check",
      description: "Check a release",
      content: "# Release Check\n",
      date: "2026-07-29T00:00:00.000Z",
      maxSkillBytes: 1024,
      secretScanMetadata: [
        {
          file: "skill-name",
          content: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        },
      ],
    });
    expect(secret).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("recognized literal credential in skill-name"),
      },
    });
  });

  it("preserves version and UTF-8 description behavior", () => {
    expect(nextProposalVersion("v1")).toBe("v2");
    expect(nextProposalVersion("invalid")).toBe("v2");
    expect(resolveUpdateProposalDescription(undefined, `  ${"é".repeat(100)}  `)).toBe(
      "é".repeat(80),
    );
  });
});
