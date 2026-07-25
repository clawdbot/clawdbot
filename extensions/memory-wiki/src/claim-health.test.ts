// Memory Wiki tests cover claim health plugin behavior.
import { describe, expect, it } from "vitest";
import { assessClaimFreshness, buildPageContradictionClusters } from "./claim-health.js";
import type { WikiClaim, WikiPageSummary } from "./markdown.js";

function createPage(params: {
  relativePath: string;
  title: string;
  contradictions: string[];
}): WikiPageSummary {
  return {
    absolutePath: `/tmp/${params.relativePath}`,
    relativePath: params.relativePath,
    kind: "entity",
    title: params.title,
    hasFrontmatter: true,
    aliases: [],
    sourceIds: [],
    linkTargets: [],
    relationships: [],
    bestUsedFor: [],
    notEnoughFor: [],
    claims: [],
    contradictions: params.contradictions,
    questions: [],
  };
}

describe("buildPageContradictionClusters", () => {
  it("clusters Unicode contradiction notes that differ only by punctuation", () => {
    const clusters = buildPageContradictionClusters([
      createPage({
        relativePath: "entities/alpha.md",
        title: "Alpha",
        contradictions: ["模型冲突：版本 A"],
      }),
      createPage({
        relativePath: "entities/beta.md",
        title: "Beta",
        contradictions: ["模型冲突 版本 A"],
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.entries).toHaveLength(2);
  });

  it("keeps combining-mark contradiction notes in separate clusters", () => {
    const clusters = buildPageContradictionClusters([
      createPage({
        relativePath: "entities/alpha.md",
        title: "Alpha",
        contradictions: ["किताब"],
      }),
      createPage({
        relativePath: "entities/beta.md",
        title: "Beta",
        contradictions: ["कीताब"],
      }),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.key).toSorted()).toEqual(["किताब", "कीताब"]);
    expect(clusters.every((cluster) => cluster.entries)).toBe(true);
  });
});

describe("assessClaimFreshness", () => {
  it("uses the latest claim evidence timestamp without relying on page freshness", () => {
    const page = createPage({
      relativePath: "entities/alpha.md",
      title: "Alpha",
      contradictions: [],
    });
    page.updatedAt = "2026-01-01T00:00:00.000Z";
    const claim: WikiClaim = {
      text: "Alpha prefers current evidence.",
      updatedAt: "2026-01-05T00:00:00.000Z",
      evidence: [
        { updatedAt: "2026-01-03T00:00:00.000Z" },
        { updatedAt: "2026-01-20T00:00:00.000Z" },
      ],
    };

    const freshness = assessClaimFreshness({
      page,
      claim,
      now: new Date("2026-01-25T00:00:00.000Z"),
    });

    expect(freshness.level).toBe("fresh");
    expect(freshness.lastTouchedAt).toBe("2026-01-20T00:00:00.000Z");
    expect(freshness.daysSinceTouch).toBe(5);
  });

  it("does not let a newer page timestamp make stale claim evidence fresh", () => {
    const page = createPage({
      relativePath: "entities/beta.md",
      title: "Beta",
      contradictions: [],
    });
    page.updatedAt = "2026-04-20T00:00:00.000Z";
    const claim: WikiClaim = {
      text: "Beta still needs old evidence checked.",
      updatedAt: "2026-01-01T00:00:00.000Z",
      evidence: [{ updatedAt: "2026-01-05T00:00:00.000Z" }],
    };

    const freshness = assessClaimFreshness({
      page,
      claim,
      now: new Date("2026-04-20T00:00:00.000Z"),
    });

    expect(freshness.level).toBe("stale");
    expect(freshness.lastTouchedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(freshness.daysSinceTouch).toBe(105);
  });

  it("falls back to page freshness when claim and evidence timestamps are absent", () => {
    const page = createPage({
      relativePath: "entities/gamma.md",
      title: "Gamma",
      contradictions: [],
    });
    page.updatedAt = "2026-04-20T00:00:00.000Z";
    const claim: WikiClaim = {
      text: "Gamma was written through wiki_apply without per-claim timestamps.",
      evidence: [{ kind: "session", sourceId: "session-1" }],
    };

    const freshness = assessClaimFreshness({
      page,
      claim,
      now: new Date("2026-04-25T00:00:00.000Z"),
    });

    expect(freshness.level).toBe("fresh");
    expect(freshness.lastTouchedAt).toBe("2026-04-20T00:00:00.000Z");
    expect(freshness.daysSinceTouch).toBe(5);
  });

  it("keeps malformed claim timestamps unknown instead of using page freshness", () => {
    const page = createPage({
      relativePath: "entities/delta.md",
      title: "Delta",
      contradictions: [],
    });
    page.updatedAt = "2026-04-20T00:00:00.000Z";
    const claim: WikiClaim = {
      text: "Delta has malformed claim freshness metadata.",
      updatedAt: "not-a-date",
      evidence: [],
    };

    const freshness = assessClaimFreshness({
      page,
      claim,
      now: new Date("2026-04-25T00:00:00.000Z"),
    });

    expect(freshness.level).toBe("unknown");
    expect(freshness.lastTouchedAt).toBeUndefined();
    expect(freshness.reason).toBe("missing updatedAt");
  });
});
