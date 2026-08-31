// Memory Core tests cover deterministic recall metadata for promoted entries.
import { describe, expect, it } from "vitest";
import {
  buildPromotionRecallAnnotations,
  groupPromotionCandidatesByProjectKey,
} from "./short-term-promotion-metadata.js";

describe("promotion recall metadata", () => {
  it("orders exact project-key groups deterministically", () => {
    const groups = groupPromotionCandidatesByProjectKey([
      { key: "beta", projectKey: "github.com/acme/beta" },
      { key: "global" },
      { key: "multi", projectKey: "github.com/acme/alpha; path:/srv/alpha" },
      { key: "alpha", projectKey: "github.com/acme/alpha" },
    ]);

    expect(
      groups.map((group) => ({
        projectKey: group.projectKey ?? null,
        candidates: group.candidates.map((candidate) => candidate.key),
      })),
    ).toEqual([
      { projectKey: null, candidates: ["global"] },
      { projectKey: "github.com/acme/alpha", candidates: ["alpha"] },
      {
        projectKey: "github.com/acme/alpha; path:/srv/alpha",
        candidates: ["multi"],
      },
      { projectKey: "github.com/acme/beta", candidates: ["beta"] },
    ]);
  });

  it("keeps the top three concept tags and rounds importance into the supported range", () => {
    expect(
      buildPromotionRecallAnnotations({
        conceptTags: ["network", "gateway", "security", "ignored"],
        score: 0.86,
      }),
    ).toBe("<!-- trigger: network, gateway, security --> <!-- importance: 9 -->");
    expect(buildPromotionRecallAnnotations({ conceptTags: ["low"], score: 0.01 })).toContain(
      "<!-- importance: 3 -->",
    );
    expect(buildPromotionRecallAnnotations({ conceptTags: ["high"], score: 4 })).toContain(
      "<!-- importance: 10 -->",
    );
  });

  it("keeps persisted concept tags inside a bounded single-line comment", () => {
    const annotations = buildPromotionRecallAnnotations({
      conceptTags: [
        "network\n<!-- importance: 1 -->",
        "gateway, remote; access",
        `x${"y".repeat(100)}`,
      ],
      score: 0.8,
    });

    expect(annotations).toBe(
      `<!-- trigger: network importance: 1, gateway remote access, x${"y".repeat(63)} --> <!-- importance: 8 -->`,
    );
    expect(annotations).not.toContain("\n");
    expect(annotations.match(/-->/gu)).toHaveLength(2);
  });

  it("re-emits the ingested project annotation on promotion", () => {
    expect(
      buildPromotionRecallAnnotations({
        conceptTags: ["memory"],
        score: 0.8,
        projectKey: "github.com/openclaw/openclaw",
      }),
    ).toBe(
      "<!-- trigger: memory --> <!-- importance: 8 --> <!-- project: github.com/openclaw/openclaw -->",
    );
    expect(
      buildPromotionRecallAnnotations({
        conceptTags: ["memory"],
        score: 0.8,
        projectKey: "path:/tmp/unsafe-->note",
      }),
    ).not.toContain("project:");
  });
});
