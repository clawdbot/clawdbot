import { describe, expect, it } from "vitest";
import { filterSkillWorkshopProposals, type SkillWorkshopProposal } from "./index.ts";

function proposal(overrides: Partial<SkillWorkshopProposal> = {}): SkillWorkshopProposal {
  return {
    key: "release-suggestion",
    kind: "update",
    slug: "release-sanity",
    name: "Release checks",
    oneLine: "Verify rollback before publishing.",
    body: "## Workflow\n- Verify the release.",
    status: "pending",
    version: 1,
    revisionHash: null,
    createdAt: 1,
    recencyGroup: "today",
    ageLabel: "now",
    supportFiles: [],
    bodyLoaded: true,
    ...overrides,
  };
}

describe("Skill Workshop suggestion filtering", () => {
  it("keeps decided records out of suggestion results", () => {
    const pending = proposal();
    const records = (["applied", "rejected", "quarantined", "stale"] as const).map((status) =>
      proposal({ key: status, status }),
    );

    expect(filterSkillWorkshopProposals([...records, pending], "")).toEqual([pending]);
    expect(filterSkillWorkshopProposals(records, "release")).toEqual([]);
  });

  it.each([" CHECKS ", "rollback", "RELEASE-SANITY"])(
    "finds pending suggestions by title, description, or skill name with %s",
    (query) => {
      const match = proposal();
      const unrelated = proposal({
        key: "inbox-review",
        name: "Inbox review",
        slug: "inbox-review",
        oneLine: "Review unread mail.",
      });

      expect(filterSkillWorkshopProposals([unrelated, match], query)).toEqual([match]);
    },
  );
});
