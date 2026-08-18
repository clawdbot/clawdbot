import { describe, expect, it } from "vitest";
import {
  filterSkillWorkshopAppliedSkills,
  filterSkillWorkshopProposals,
  type SkillWorkshopProposal,
  type SkillWorkshopProposalStatus,
} from "./index.ts";

function proposal(options: {
  key: string;
  status?: SkillWorkshopProposalStatus;
  slug?: string;
  description?: string;
  updatedAt?: number;
}): SkillWorkshopProposal {
  return {
    key: options.key,
    slug: options.slug ?? "release-sanity",
    name: `Update ${options.slug ?? "release-sanity"}`,
    oneLine: options.description ?? `Description for ${options.key}`,
    body: "## Workflow\n- Verify the release.",
    status: options.status ?? "applied",
    version: 1,
    revisionHash: null,
    createdAt: options.updatedAt ?? 1,
    updatedAt: options.updatedAt,
    recencyGroup: "today",
    ageLabel: "now",
    supportFiles: [],
    isNew: false,
  };
}

describe("Skill Workshop proposal filtering", () => {
  it("groups applied revisions by skill with deterministic newest-first history", () => {
    const proposals = [
      proposal({ key: "revision-a", updatedAt: 1 }),
      proposal({ key: "revision-c", updatedAt: 3 }),
      proposal({ key: "revision-b", updatedAt: 2 }),
      proposal({ key: "revision-d", updatedAt: 3 }),
    ];

    expect(filterSkillWorkshopProposals(proposals, "applied", "").map((item) => item.key)).toEqual([
      "revision-d",
    ]);
    const [skill] = filterSkillWorkshopAppliedSkills(proposals, "");
    expect(
      skill?.revisions.map(({ proposal: revisionProposal, operation, version }) => ({
        key: revisionProposal.key,
        operation,
        version,
      })),
    ).toEqual([
      { key: "revision-d", operation: "update", version: 4 },
      { key: "revision-c", operation: "update", version: 3 },
      { key: "revision-b", operation: "update", version: 2 },
      { key: "revision-a", operation: "create", version: 1 },
    ]);
  });

  it("searches every revision while returning the grouped skill row", () => {
    const proposals = [
      proposal({ key: "new", description: "Current release checks", updatedAt: 2 }),
      proposal({ key: "old", description: "Legacy rollback phrase", updatedAt: 1 }),
    ];

    expect(
      filterSkillWorkshopProposals(proposals, "applied", "legacy rollback").map((item) => item.key),
    ).toEqual(["new"]);
  });

  it("keeps non-applied filters and the all view proposal-based", () => {
    const proposals = [
      proposal({ key: "pending", status: "pending" }),
      proposal({ key: "rejected", status: "rejected" }),
      proposal({ key: "quarantined", status: "quarantined" }),
      proposal({ key: "stale", status: "stale" }),
      proposal({ key: "applied-a" }),
      proposal({ key: "applied-b" }),
    ];

    for (const status of ["pending", "rejected", "quarantined", "stale"] as const) {
      expect(filterSkillWorkshopProposals(proposals, status, "").map((item) => item.key)).toEqual([
        status,
      ]);
    }
    expect(filterSkillWorkshopProposals(proposals, "all", "")).toEqual(proposals);
  });
});
