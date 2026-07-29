// Memory Wiki tests cover tool plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiLintTool, createWikiOpenItemsTool } from "./tool.js";

async function writeSynthesisPage(
  rootDir: string,
  relativePath: string,
  frontmatterLines: string[],
): Promise<void> {
  const absolutePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(
    absolutePath,
    ["---", "pageType: synthesis", ...frontmatterLines, "---", "", "Body."].join("\n"),
    "utf8",
  );
}

function asSchemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON schema object");
  }
  return value as Record<string, unknown>;
}

function unionLiteralValues(schema: Record<string, unknown>): string[] {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(variants)) {
    throw new Error("Expected union schema variants");
  }
  return variants
    .map((variant) => asSchemaObject(variant).const)
    .filter((value): value is string => typeof value === "string")
    .toSorted();
}

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  it("accepts CLI-style operation aliases in wiki_apply schema", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const opSchema = asSchemaObject(applyProperties.op);

    expect(unionLiteralValues(opSchema)).toEqual([
      "create_synthesis",
      "metadata",
      "synthesis",
      "update_metadata",
    ]);
  });

  it("allows provenance metadata in wiki_apply claim evidence", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const claimsSchema = asSchemaObject(applyProperties.claims);
    const claimSchema = asSchemaObject(claimsSchema.items);
    const claimProperties = asSchemaObject(claimSchema.properties);
    const evidenceSchema = asSchemaObject(claimProperties.evidence);
    const evidenceArraySchema = asSchemaObject(evidenceSchema.items);
    const evidenceProperties = asSchemaObject(evidenceArraySchema.properties);

    expect(Object.keys(evidenceProperties).toSorted()).toEqual([
      "confidence",
      "kind",
      "lines",
      "note",
      "path",
      "privacyTier",
      "sourceId",
      "updatedAt",
      "weight",
    ]);
    expect(evidenceProperties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });

  it("returns tool-safe relative report paths from wiki_lint", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "bad.md"),
      [
        "---",
        "id: synth-bad",
        "pageType: synthesis",
        "title: Bad Page",
        "---",
        "",
        "This links to [[Missing Page]].",
      ].join("\n"),
      "utf8",
    );

    const tool = createWikiLintTool(config);
    const result = await tool.execute("lint-call", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);

    expect(text).toContain("Report: reports/lint.md");
    expect(text).not.toContain(rootDir);
    expect(details.reportPath).toBe("reports/lint.md");
    expect(details).not.toHaveProperty("vaultRoot");
    expect(JSON.stringify(details)).not.toContain(rootDir);
    expect(asSchemaObject(details.issuesByCategory).links).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "broken-wikilink" })]),
    );

    const lintResult = await lintMemoryWikiVault(config);
    expect(path.isAbsolute(lintResult.reportPath)).toBe(true);
    expect(lintResult.reportPath).toContain(rootDir);
  });

  it("exposes a provider-safe flat string enum for the wiki_open_items kinds filter", () => {
    const tool = createWikiOpenItemsTool({} as ResolvedMemoryWikiConfig);
    const properties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const kindsSchema = asSchemaObject(properties.kinds);
    const itemSchema = asSchemaObject(kindsSchema.items);

    // Must be a flat { type: "string", enum: [...] }, not an anyOf union that
    // some provider tool-schema validators reject.
    expect(itemSchema.type).toBe("string");
    expect(itemSchema).not.toHaveProperty("anyOf");
    expect(itemSchema).not.toHaveProperty("oneOf");
    expect((itemSchema.enum as string[]).toSorted()).toEqual([
      "claim-contradiction",
      "low-confidence-claim",
      "low-confidence-page",
      "open-question",
      "page-contradiction",
    ]);
  });

  it("enumerates open items and surfaces competing claim statements through the registered tool", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await writeSynthesisPage(rootDir, path.join("syntheses", "a.md"), [
      "id: synth-a",
      "title: Alpha",
      "confidence: 0.3",
      "questions:",
      "  - Is the March deadline still correct?",
      "claims:",
      "  - id: c1",
      "    text: deadline is March 15",
      "    status: supported",
    ]);
    await writeSynthesisPage(rootDir, path.join("syntheses", "b.md"), [
      "id: synth-b",
      "title: Beta",
      "claims:",
      "  - id: c1",
      "    text: deadline is April 1",
      "    status: supported",
    ]);

    const tool = createWikiOpenItemsTool(config);
    const result = await tool.execute("open-items-call", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);
    const vaultCounts = asSchemaObject(details.vaultCounts);

    // The claim-contradiction item must carry the real competing statements.
    expect(text).toContain("deadline is March 15");
    expect(text).toContain("deadline is April 1");
    expect(text).not.toContain("[claim-contradiction] c1");
    expect(vaultCounts["open-question"]).toBe(1);
    expect(vaultCounts["low-confidence-page"]).toBe(1);
    expect(vaultCounts["claim-contradiction"]).toBe(1);
    expect(vaultCounts.total).toBe(3);
    expect(JSON.stringify(details)).not.toContain(rootDir);
  });

  it("filters by kind and limit, and reports counts that match the returned items", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await writeSynthesisPage(rootDir, path.join("syntheses", "q.md"), [
      "id: synth-q",
      "title: Questions",
      "questions:",
      "  - First open question?",
      "  - Second open question?",
      "confidence: 0.2",
    ]);

    const tool = createWikiOpenItemsTool(config);

    const filtered = await tool.execute("open-items-filtered", { kinds: ["open-question"] });
    const filteredDetails = asSchemaObject(filtered.details);
    const filteredCounts = asSchemaObject(filteredDetails.counts);
    const filteredVaultCounts = asSchemaObject(filteredDetails.vaultCounts);
    expect(filteredCounts.total).toBe(2);
    expect(filteredCounts["open-question"]).toBe(2);
    expect(filteredCounts["low-confidence-page"]).toBe(0);
    // vaultCounts still reflects the whole vault (2 questions + 1 low-confidence page).
    expect(filteredVaultCounts.total).toBe(3);
    expect(filteredVaultCounts["low-confidence-page"]).toBe(1);

    const limited = await tool.execute("open-items-limited", { limit: 1 });
    const limitedCounts = asSchemaObject(asSchemaObject(limited.details).counts);
    expect(limitedCounts.total).toBe(1);
  });
});
