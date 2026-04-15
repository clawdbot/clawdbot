import { describe, expect, it } from "vitest";
import { buildPageContradictionClusters } from "./claim-health.js";
import type { WikiPageSummary } from "./markdown.js";

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
    sourceIds: [],
    linkTargets: [],
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
