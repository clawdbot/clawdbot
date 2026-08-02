import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderDocsHeadingMap } from "../../scripts/docs-list.js";
import { restorePrepackArtifacts } from "../../scripts/openclaw-postpack.mjs";
import { preparePackageChangelog } from "../../scripts/package-changelog.mjs";
import { preparePackageDocsMap, restorePackageDocsMap } from "../../scripts/package-docs-map.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const sourceChangelog = `# Changelog

## 2026.8.1
- Current release notes with enough detail for package validation.

## 2026.7.1
- Previous release notes with enough detail for package validation.
`;
const sourceDocsMap = "# Docs map source\n";
const sourceMaturityScorecard = "# Maturity scorecard\n\n<!-- Generated during packaging. -->\n";
const sourceMaturityTaxonomy = "# Maturity taxonomy\n\n<!-- Generated during packaging. -->\n";
const generatedMaturityScorecard = [
  "# Maturity scorecard",
  "",
  "## QA evidence summary",
  "",
  "### Readiness by area",
  "",
].join("\n");
const generatedMaturityTaxonomy = [
  "# Maturity taxonomy",
  "",
  "## Maturity levels",
  "",
  "### Provider and tool",
  "",
].join("\n");
const fakeMaturityRenderer = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error("missing fixture renderer argument: " + name);
  }
  return process.argv[index + 1];
}

const outputDir = argument("--output-dir");
const docsRoot = argument("--docs-root");
const taxonomyPath = argument("--taxonomy");
const scoresPath = argument("--scores");
const statePath = argument("--state");
if (!process.argv.includes("--strict-inputs")) {
  throw new Error("fixture renderer requires strict inputs");
}
for (const candidate of [outputDir, docsRoot, taxonomyPath, scoresPath, statePath]) {
  if (!path.isAbsolute(candidate)) {
    throw new Error("fixture renderer expected absolute path: " + candidate);
  }
}
if (docsRoot !== path.join(process.cwd(), "docs")) {
  throw new Error("fixture renderer received the wrong docs root");
}
readFileSync(taxonomyPath, "utf8");
readFileSync(scoresPath, "utf8");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const maturityDir = path.join(outputDir, "maturity");
mkdirSync(maturityDir, { recursive: true });
writeFileSync(
  path.join(maturityDir, "scorecard.md"),
  ${JSON.stringify(generatedMaturityScorecard)},
  "utf8",
);
if (state.mode === "fail-after-scorecard") {
  throw new Error("fixture renderer failed after writing the scorecard");
}
if (state.mode !== "missing-taxonomy") {
  writeFileSync(
    path.join(maturityDir, "taxonomy.md"),
    ${JSON.stringify(generatedMaturityTaxonomy)},
    "utf8",
  );
}
`;

function makePackageRoot(): string {
  const root = realpathSync(makeTempDir(tempDirs, "openclaw-package-docs-map-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "page.md"), "# Package docs\n", "utf8");
  writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.8.1"}\n');
  writeFileSync(path.join(root, "CHANGELOG.md"), sourceChangelog);
  return root;
}

function contentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function addMaturityDocs(root: string, mode = "success") {
  const maturityDir = path.join(root, "docs", "maturity");
  const qaDir = path.join(root, "qa");
  const rendererDir = path.join(root, "scripts", "qa");
  const mapPath = path.join(root, "docs", "docs_map.md");
  const scorecardPath = path.join(maturityDir, "scorecard.md");
  const taxonomyPath = path.join(maturityDir, "taxonomy.md");
  const receiptPath = path.join(root, ".artifacts", "package-docs-map", "receipt.json");

  mkdirSync(maturityDir, { recursive: true });
  mkdirSync(qaDir, { recursive: true });
  mkdirSync(rendererDir, { recursive: true });
  writeFileSync(mapPath, sourceDocsMap, "utf8");
  writeFileSync(scorecardPath, sourceMaturityScorecard, "utf8");
  writeFileSync(taxonomyPath, sourceMaturityTaxonomy, "utf8");
  writeFileSync(path.join(root, "taxonomy.yaml"), "surfaces: []\n", "utf8");
  writeFileSync(path.join(qaDir, "maturity-scores.yaml"), "surfaces: []\n", "utf8");
  writeFileSync(path.join(qaDir, "maturity-docs-state.json"), `${JSON.stringify({ mode })}\n`);
  writeFileSync(path.join(rendererDir, "render-maturity-docs.ts"), fakeMaturityRenderer, "utf8");
  symlinkSync(
    path.join(process.cwd(), "node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  return { mapPath, receiptPath, scorecardPath, taxonomyPath };
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("package docs map", () => {
  it("materializes exact generated bytes and removes only its transient copy", async () => {
    const root = makePackageRoot();
    const mapPath = path.join(root, "docs", "docs_map.md");

    await expect(preparePackageDocsMap(root)).resolves.toBe(true);
    expect(readFileSync(mapPath, "utf8")).toBe(renderDocsHeadingMap(path.join(root, "docs")));
    await expect(restorePackageDocsMap(root)).resolves.toBe(true);
    expect(existsSync(mapPath)).toBe(false);
  });

  it("preserves an identical map that existed before packaging", async () => {
    const root = makePackageRoot();
    const mapPath = path.join(root, "docs", "docs_map.md");
    const content = renderDocsHeadingMap(path.join(root, "docs"));
    writeFileSync(mapPath, content, "utf8");

    await expect(preparePackageDocsMap(root)).resolves.toBe(false);
    await expect(restorePackageDocsMap(root)).resolves.toBe(false);
    expect(readFileSync(mapPath, "utf8")).toBe(content);
  });

  it("restores a tracked source stub after packaging", async () => {
    const root = makePackageRoot();
    const mapPath = path.join(root, "docs", "docs_map.md");
    const stub = "# Docs map source\n";
    writeFileSync(mapPath, stub, "utf8");

    await expect(preparePackageDocsMap(root)).resolves.toBe(true);
    expect(readFileSync(mapPath, "utf8")).toBe(renderDocsHeadingMap(path.join(root, "docs")));
    await expect(restorePackageDocsMap(root)).resolves.toBe(true);
    expect(readFileSync(mapPath, "utf8")).toBe(stub);
  });

  it("restores a generated docs map recorded by the previous receipt format", async () => {
    const root = makePackageRoot();
    const mapPath = path.join(root, "docs", "docs_map.md");
    const receiptPath = path.join(root, ".artifacts", "package-docs-map", "receipt.json");
    const generatedMap = renderDocsHeadingMap(path.join(root, "docs"));

    writeFileSync(mapPath, generatedMap, "utf8");
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ original: sourceDocsMap, generatedSha256: contentSha256(generatedMap) })}\n`,
      "utf8",
    );

    await expect(restorePackageDocsMap(root)).resolves.toBe(true);
    expect(readFileSync(mapPath, "utf8")).toBe(sourceDocsMap);
    expect(existsSync(receiptPath)).toBe(false);
  });

  it("recovers an interrupted maturity preparation before the docs map was generated", async () => {
    const root = makePackageRoot();
    const { mapPath, receiptPath, scorecardPath, taxonomyPath } = addMaturityDocs(root);
    writeFileSync(scorecardPath, generatedMaturityScorecard, "utf8");
    writeFileSync(taxonomyPath, generatedMaturityTaxonomy, "utf8");
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(
      receiptPath,
      `${JSON.stringify({
        artifacts: [
          {
            path: path.join("docs", "maturity", "scorecard.md"),
            original: sourceMaturityScorecard,
            originalSha256: contentSha256(sourceMaturityScorecard),
            generatedSha256: contentSha256(generatedMaturityScorecard),
          },
          {
            path: path.join("docs", "maturity", "taxonomy.md"),
            original: sourceMaturityTaxonomy,
            originalSha256: contentSha256(sourceMaturityTaxonomy),
            generatedSha256: contentSha256(generatedMaturityTaxonomy),
          },
          {
            path: path.join("docs", "docs_map.md"),
            original: sourceDocsMap,
            originalSha256: contentSha256(sourceDocsMap),
            generatedSha256: null,
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(restorePackageDocsMap(root)).resolves.toBe(true);
    expect(readFileSync(scorecardPath, "utf8")).toBe(sourceMaturityScorecard);
    expect(readFileSync(taxonomyPath, "utf8")).toBe(sourceMaturityTaxonomy);
    expect(readFileSync(mapPath, "utf8")).toBe(sourceDocsMap);
    expect(existsSync(receiptPath)).toBe(false);
  });

  it("materializes maturity docs before the heading map and restores every source stub", async () => {
    const root = makePackageRoot();
    const { mapPath, receiptPath, scorecardPath, taxonomyPath } = addMaturityDocs(root);

    await expect(preparePackageDocsMap(root)).resolves.toBe(true);

    expect(readFileSync(scorecardPath, "utf8")).toBe(generatedMaturityScorecard);
    expect(readFileSync(taxonomyPath, "utf8")).toBe(generatedMaturityTaxonomy);
    const generatedMap = readFileSync(mapPath, "utf8");
    expect(generatedMap).toBe(renderDocsHeadingMap(path.join(root, "docs")));
    expect(generatedMap).toContain("  - H2: QA evidence summary");
    expect(generatedMap).toContain("  - H3: Readiness by area");
    expect(generatedMap).toContain("  - H2: Maturity levels");
    expect(generatedMap).toContain("  - H3: Provider and tool");
    expect(existsSync(receiptPath)).toBe(true);

    await expect(restorePackageDocsMap(root)).resolves.toBe(true);

    expect(readFileSync(scorecardPath, "utf8")).toBe(sourceMaturityScorecard);
    expect(readFileSync(taxonomyPath, "utf8")).toBe(sourceMaturityTaxonomy);
    expect(readFileSync(mapPath, "utf8")).toBe(sourceDocsMap);
    expect(existsSync(receiptPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "atomically replaces every generated artifact and restored source stub",
    async () => {
      const root = makePackageRoot();
      const { mapPath, scorecardPath, taxonomyPath } = addMaturityDocs(root);
      const artifactPaths = [scorecardPath, taxonomyPath, mapPath];
      const originalInodes = artifactPaths.map((artifactPath) => statSync(artifactPath).ino);

      await expect(preparePackageDocsMap(root)).resolves.toBe(true);

      const generatedInodes = artifactPaths.map((artifactPath) => statSync(artifactPath).ino);
      expect(generatedInodes.every((inode, index) => inode !== originalInodes[index])).toBe(true);

      await expect(restorePackageDocsMap(root)).resolves.toBe(true);

      const restoredInodes = artifactPaths.map((artifactPath) => statSync(artifactPath).ino);
      expect(restoredInodes.every((inode, index) => inode !== generatedInodes[index])).toBe(true);
      for (const artifactPath of artifactPaths) {
        expect(
          readdirSync(path.dirname(artifactPath)).some((entry) => entry.endsWith(".tmp")),
        ).toBe(false);
      }
    },
  );

  it.each(["scorecard.md", "taxonomy.md"])(
    "keeps every generated doc and the lifecycle receipt when an operator edits %s",
    async (editedName) => {
      const root = makePackageRoot();
      const { mapPath, receiptPath, scorecardPath, taxonomyPath } = addMaturityDocs(root);

      await preparePackageDocsMap(root);
      const generatedMap = readFileSync(mapPath, "utf8");
      const editedPath = editedName === "scorecard.md" ? scorecardPath : taxonomyPath;
      const editedGeneratedContent = readFileSync(editedPath, "utf8");
      writeFileSync(editedPath, "# Operator change\n", "utf8");

      await expect(restorePackageDocsMap(root)).rejects.toThrow();

      expect(existsSync(receiptPath)).toBe(true);
      expect(readFileSync(mapPath, "utf8")).toBe(generatedMap);
      expect(readFileSync(scorecardPath, "utf8")).toBe(
        editedName === "scorecard.md" ? "# Operator change\n" : generatedMaturityScorecard,
      );
      expect(readFileSync(taxonomyPath, "utf8")).toBe(
        editedName === "taxonomy.md" ? "# Operator change\n" : generatedMaturityTaxonomy,
      );

      writeFileSync(editedPath, editedGeneratedContent, "utf8");
      await expect(restorePackageDocsMap(root)).resolves.toBe(true);
      expect(readFileSync(scorecardPath, "utf8")).toBe(sourceMaturityScorecard);
      expect(readFileSync(taxonomyPath, "utf8")).toBe(sourceMaturityTaxonomy);
      expect(readFileSync(mapPath, "utf8")).toBe(sourceDocsMap);
      expect(existsSync(receiptPath)).toBe(false);
    },
  );

  it.each(["original-hash", "path-traversal"])(
    "rejects a receipt with corrupt %s without restoring any source artifact",
    async (corruption) => {
      const root = makePackageRoot();
      const { mapPath, receiptPath, scorecardPath, taxonomyPath } = addMaturityDocs(root);
      await preparePackageDocsMap(root);
      const generatedMap = readFileSync(mapPath, "utf8");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        artifacts: Array<{ originalSha256: string | null; path: string }>;
      };
      const artifact = receipt.artifacts[0];
      if (!artifact) {
        throw new Error("package docs receipt fixture is missing its first artifact");
      }
      if (corruption === "original-hash") {
        artifact.originalSha256 = "0".repeat(64);
      } else {
        artifact.path = path.join("docs", "..", "operator.md");
      }
      writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

      await expect(restorePackageDocsMap(root)).rejects.toThrow("Invalid package docs-map receipt");

      expect(readFileSync(scorecardPath, "utf8")).toBe(generatedMaturityScorecard);
      expect(readFileSync(taxonomyPath, "utf8")).toBe(generatedMaturityTaxonomy);
      expect(readFileSync(mapPath, "utf8")).toBe(generatedMap);
      expect(existsSync(receiptPath)).toBe(true);
    },
  );

  it.each(["fail-after-scorecard", "missing-taxonomy"])(
    "leaves every stub and the lifecycle lock untouched when the maturity renderer returns %s",
    async (mode) => {
      const root = makePackageRoot();
      const { mapPath, receiptPath, scorecardPath, taxonomyPath } = addMaturityDocs(root, mode);

      await expect(preparePackageDocsMap(root)).rejects.toThrow();

      expect(readFileSync(scorecardPath, "utf8")).toBe(sourceMaturityScorecard);
      expect(readFileSync(taxonomyPath, "utf8")).toBe(sourceMaturityTaxonomy);
      expect(readFileSync(mapPath, "utf8")).toBe(sourceDocsMap);
      expect(existsSync(receiptPath)).toBe(false);
    },
  );

  it("serializes concurrent package preparations with the receipt", async () => {
    const root = makePackageRoot();
    const mapPath = path.join(root, "docs", "docs_map.md");
    const stub = "# Docs map source\n";
    writeFileSync(mapPath, stub, "utf8");

    const results = await Promise.allSettled([
      preparePackageDocsMap(root),
      preparePackageDocsMap(root),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        code: "PACKAGE_DOCS_MAP_ACTIVE",
        message: expect.stringContaining("node scripts/openclaw-postpack.mjs"),
      }),
    });
    expect(readFileSync(mapPath, "utf8")).toBe(renderDocsHeadingMap(path.join(root, "docs")));
    await expect(restorePackageDocsMap(root)).resolves.toBe(true);
    expect(readFileSync(mapPath, "utf8")).toBe(stub);
  });

  it("serializes concurrent owners while preparing maturity docs", async () => {
    const root = makePackageRoot();
    const { mapPath, receiptPath, scorecardPath, taxonomyPath } = addMaturityDocs(root);

    const results = await Promise.allSettled([
      preparePackageDocsMap(root),
      preparePackageDocsMap(root),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "PACKAGE_DOCS_MAP_ACTIVE" }),
    });
    expect(existsSync(receiptPath)).toBe(true);
    expect(readFileSync(scorecardPath, "utf8")).toBe(generatedMaturityScorecard);
    expect(readFileSync(taxonomyPath, "utf8")).toBe(generatedMaturityTaxonomy);
    expect(readFileSync(mapPath, "utf8")).toBe(renderDocsHeadingMap(path.join(root, "docs")));

    await expect(restorePackageDocsMap(root)).resolves.toBe(true);
    expect(readFileSync(scorecardPath, "utf8")).toBe(sourceMaturityScorecard);
    expect(readFileSync(taxonomyPath, "utf8")).toBe(sourceMaturityTaxonomy);
    expect(readFileSync(mapPath, "utf8")).toBe(sourceDocsMap);
    expect(existsSync(receiptPath)).toBe(false);
  });

  it("refuses to remove a transient map changed after prepack", async () => {
    const root = makePackageRoot();
    const mapPath = path.join(root, "docs", "docs_map.md");
    await preparePackageDocsMap(root);
    writeFileSync(mapPath, "operator change\n", "utf8");

    await expect(restorePackageDocsMap(root)).rejects.toThrow("changed after prepack");
    expect(readFileSync(mapPath, "utf8")).toBe("operator change\n");
  });

  it("keeps the lifecycle lock until interrupted changelog state is restored", async () => {
    const root = makePackageRoot();
    const mapPath = path.join(root, "docs", "docs_map.md");
    const receiptPath = path.join(root, ".artifacts", "package-docs-map", "receipt.json");
    const changelogBackupPath = path.join(
      root,
      ".artifacts",
      "package-changelog",
      "CHANGELOG.md.prepack-backup",
    );
    const stub = "# Docs map source\n";
    writeFileSync(mapPath, stub);

    await preparePackageDocsMap(root);
    await preparePackageChangelog(root);
    const packagedChangelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    writeFileSync(path.join(root, "CHANGELOG.md"), "operator change\n");

    await expect(restorePrepackArtifacts(root)).rejects.toThrow("changed since the backup");
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(changelogBackupPath)).toBe(true);
    expect(readFileSync(mapPath, "utf8")).toBe(renderDocsHeadingMap(path.join(root, "docs")));

    writeFileSync(path.join(root, "CHANGELOG.md"), packagedChangelog);
    await expect(restorePrepackArtifacts(root)).resolves.toBeUndefined();
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
    expect(readFileSync(mapPath, "utf8")).toBe(stub);
    expect(existsSync(changelogBackupPath)).toBe(false);
    expect(existsSync(receiptPath)).toBe(false);
  });
});
