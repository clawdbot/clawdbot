// Memory Wiki tests cover open-items enumeration plugin behavior.
import { describe, expect, it } from "vitest";
import type { WikiClaim, WikiPageSummary } from "./markdown.js";
import { deriveMemoryWikiOpenItems } from "./open-items.js";

function createPage(params: {
  relativePath: string;
  title: string;
  id?: string;
  questions?: string[];
  contradictions?: string[];
  claims?: WikiClaim[];
  confidence?: number;
}): WikiPageSummary {
  return {
    absolutePath: `/tmp/${params.relativePath}`,
    relativePath: params.relativePath,
    kind: "synthesis",
    title: params.title,
    hasFrontmatter: true,
    aliases: [],
    sourceIds: [],
    linkTargets: [],
    relationships: [],
    bestUsedFor: [],
    notEnoughFor: [],
    claims: params.claims ?? [],
    contradictions: params.contradictions ?? [],
    questions: params.questions ?? [],
    ...(params.id ? { id: params.id } : {}),
    ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
  };
}

describe("deriveMemoryWikiOpenItems", () => {
  it("enumerates open questions, page contradictions, and low-confidence pages/claims", () => {
    const pages = [
      createPage({
        relativePath: "syntheses/topic.md",
        title: "Topic",
        id: "syn.topic",
        questions: ["Is the nightly job still needed?"],
        contradictions: ["Doc says 3am; log shows 4am"],
        confidence: 0.3,
        claims: [{ text: "runs at 3am", status: "supported", confidence: 0.2, evidence: [] }],
      }),
    ];

    const { items, counts } = deriveMemoryWikiOpenItems(pages);

    expect(counts.total).toBe(4);
    expect(counts["open-question"]).toBe(1);
    expect(counts["page-contradiction"]).toBe(1);
    expect(counts["low-confidence-page"]).toBe(1);
    expect(counts["low-confidence-claim"]).toBe(1);
    expect(items.find((item) => item.kind === "open-question")?.text).toBe(
      "Is the nightly job still needed?",
    );
    expect(items.every((item) => item.pagePath === "syntheses/topic.md")).toBe(true);
    expect(items.find((item) => item.kind === "low-confidence-claim")?.confidence).toBe(0.2);
  });

  it("clusters competing claims that share an id across pages", () => {
    const pages = [
      createPage({
        relativePath: "syntheses/a.md",
        title: "A",
        claims: [{ id: "c1", text: "deadline is March 15", status: "supported", evidence: [] }],
      }),
      createPage({
        relativePath: "syntheses/b.md",
        title: "B",
        claims: [{ id: "c1", text: "deadline is April 1", status: "supported", evidence: [] }],
      }),
    ];

    const { items, counts } = deriveMemoryWikiOpenItems(pages);

    expect(counts["claim-contradiction"]).toBe(1);
    const item = items.find((entry) => entry.kind === "claim-contradiction");
    expect(item?.claimId).toBe("c1");
    expect(item?.relatedPagePaths).toEqual(["syntheses/a.md", "syntheses/b.md"]);
    // text must carry the actual competing statements, not the opaque claim id.
    expect(item?.text).not.toBe("c1");
    expect(item?.text).toContain("deadline is March 15");
    expect(item?.text).toContain("deadline is April 1");
    expect(item?.variants).toEqual([
      {
        text: "deadline is March 15",
        status: "supported",
        pagePath: "syntheses/a.md",
        pageTitle: "A",
      },
      {
        text: "deadline is April 1",
        status: "supported",
        pagePath: "syntheses/b.md",
        pageTitle: "B",
      },
    ]);
  });

  it("returns nothing for a clean vault", () => {
    const pages = [
      createPage({
        relativePath: "syntheses/clean.md",
        title: "Clean",
        confidence: 0.9,
        claims: [{ text: "all good", status: "supported", confidence: 0.9, evidence: [] }],
      }),
    ];

    const { items, counts } = deriveMemoryWikiOpenItems(pages);

    expect(items).toHaveLength(0);
    expect(counts.total).toBe(0);
  });
});
