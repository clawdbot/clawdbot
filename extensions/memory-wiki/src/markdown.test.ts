import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createWikiPageFilename,
  renderWikiMarkdown,
  slugifyWikiSegment,
  toWikiPageSummary,
} from "./markdown.js";

describe("slugifyWikiSegment", () => {
  it("preserves Unicode letters and numbers in wiki slugs", () => {
    expect(slugifyWikiSegment("大语言模型概述")).toBe("大语言模型概述");
    expect(slugifyWikiSegment("LLM 架构分析")).toBe("llm-架构分析");
    expect(slugifyWikiSegment("Circuit Breaker 自動恢復")).toBe("circuit-breaker-自動恢復");
  });

  it("keeps ASCII behavior unchanged", () => {
    expect(slugifyWikiSegment("hello world")).toBe("hello-world");
    expect(slugifyWikiSegment("")).toBe("page");
  });

  it("retains combining marks so distinct titles do not collapse", () => {
    expect(slugifyWikiSegment("किताब")).toBe("किताब");
    expect(slugifyWikiSegment("कुतुब")).toBe("कुतुब");
    expect(slugifyWikiSegment("कीताब")).toBe("कीताब");
  });

  it("caps long Unicode slugs to a safe filename byte length", () => {
    const title = "漢".repeat(90);
    const slug = slugifyWikiSegment(title);

    expect(slug.endsWith(`-${createHash("sha1").update(title).digest("hex").slice(0, 12)}`)).toBe(
      true,
    );
    expect(Buffer.byteLength(slug)).toBeLessThanOrEqual(240);
    expect(slugifyWikiSegment(title)).toBe(slug);
  });

  it("caps composed wiki page filenames to a safe path-component length", () => {
    const stem = `bridge-${"漢".repeat(45)}-${"語".repeat(45)}`;
    const fileName = createWikiPageFilename(stem);

    expect(fileName.endsWith(".md")).toBe(true);
    expect(
      Buffer.byteLength(`.${fileName}.00000000-0000-4000-8000-000000000000.fallback.tmp`),
    ).toBeLessThanOrEqual(255);
    expect(createWikiPageFilename(stem)).toBe(fileName);
  });
});

describe("toWikiPageSummary", () => {
  it("normalizes agent-facing people wiki metadata", () => {
    const raw = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        entityType: "person",
        id: "entity.brad",
        title: "Brad Groux",
        canonicalId: "maintainer.brad-groux",
        aliases: ["brad", "bgroux"],
        privacyTier: "local-private",
        bestUsedFor: ["Microsoft ecosystem routing"],
        notEnoughFor: ["legal approval"],
        lastRefreshedAt: "2026-04-29T00:00:00.000Z",
        personCard: {
          handles: ["@bgroux"],
          socials: ["https://x.example/bgroux"],
          email: "brad@example.com",
          timezone: "America/Chicago",
          lane: "Microsoft Teams",
          askFor: ["Teams and Azure questions"],
          avoidAskingFor: ["unrelated billing"],
          confidence: 0.8,
          privacyTier: "confirm-before-use",
          lastRefreshedAt: "2026-04-28T00:00:00.000Z",
        },
        relationships: [
          {
            targetId: "entity.alice",
            targetTitle: "Alice",
            kind: "collaborates-with",
            weight: 0.7,
            confidence: 0.6,
            evidenceKind: "discrawl-stat",
            privacyTier: "local-private",
          },
        ],
        claims: [
          {
            id: "claim.brad.teams",
            text: "Brad is useful for Microsoft Teams routing.",
            confidence: 0.9,
            evidence: [
              {
                kind: "maintainer-whois",
                sourceId: "source.maintainers",
                confidence: 0.8,
                privacyTier: "local-private",
              },
            ],
          },
        ],
      },
      body: "# Brad Groux\n",
    });

    const summary = toWikiPageSummary({
      absolutePath: "/tmp/wiki/entities/brad.md",
      relativePath: "entities/brad.md",
      raw,
    });

    expect(summary).toEqual(
      expect.objectContaining({
        entityType: "person",
        canonicalId: "maintainer.brad-groux",
        aliases: ["brad", "bgroux"],
        privacyTier: "local-private",
        bestUsedFor: ["Microsoft ecosystem routing"],
        notEnoughFor: ["legal approval"],
        lastRefreshedAt: "2026-04-29T00:00:00.000Z",
        personCard: expect.objectContaining({
          handles: ["@bgroux"],
          emails: ["brad@example.com"],
          lane: "Microsoft Teams",
          privacyTier: "confirm-before-use",
        }),
        relationships: [
          expect.objectContaining({
            targetId: "entity.alice",
            kind: "collaborates-with",
            evidenceKind: "discrawl-stat",
          }),
        ],
        claims: [
          expect.objectContaining({
            id: "claim.brad.teams",
            evidence: [
              expect.objectContaining({
                kind: "maintainer-whois",
                privacyTier: "local-private",
              }),
            ],
          }),
        ],
      }),
    );
  });
});
