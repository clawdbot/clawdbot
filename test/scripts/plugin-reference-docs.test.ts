import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializePluginReferenceDocs, renderDocsHeadingMap } from "../../scripts/docs-list.js";
import { preparePackageDocsMap, restorePackageDocsMap } from "../../scripts/package-docs-map.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const manualStart = "<!-- openclaw-plugin-reference:manual-start -->";
const manualEnd = "<!-- openclaw-plugin-reference:manual-end -->";

function runGenerator(root: string, mode: string) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts", "generate-plugin-inventory-doc.mjs"), mode],
    { cwd: root, encoding: "utf8" },
  );
}

function addFixturePlugin(root: string, id: string) {
  const pluginDir = path.join(root, "extensions", id);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({ name: `@openclaw/${id}` })}\n`,
  );
  writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id, description: `${id} plugin` })}\n`,
  );
}

function createPluginDocsFixture() {
  const root = tempDirs.make("openclaw-plugin-reference-docs-");
  const referenceDir = path.join(root, "docs", "plugins", "reference");
  mkdirSync(referenceDir, { recursive: true });
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  for (const relativePath of [
    "scripts/docs-list.js",
    "scripts/generate-plugin-inventory-doc.mjs",
    "scripts/lib/plugin-inventory-doc.mjs",
  ]) {
    copyFileSync(path.join(repoRoot, relativePath), path.join(root, relativePath));
  }
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "plugin-docs-fixture", version: "1.0.0", files: ["docs/"] })}\n`,
  );
  writeFileSync(path.join(root, ".gitignore"), "docs/plugins/reference/generated-example.md\n");

  for (const id of ["anthropic", "generated-example"]) {
    addFixturePlugin(root, id);
  }

  const authoredPath = path.join(referenceDir, "anthropic.md");
  writeFileSync(
    authoredPath,
    `## Surface\n\nplugin\n\n${manualStart}\n\n## Operator setup\n\nPreserve this exact operator guidance.\n\n${manualEnd}\n`,
  );
  const generated = runGenerator(root, "--write");
  if (generated.status !== 0) {
    throw new Error(generated.stderr);
  }

  const generatedPath = path.join(referenceDir, "generated-example.md");
  const generatedBytes = readFileSync(generatedPath, "utf8");
  const authoredBytes = readFileSync(authoredPath, "utf8");
  rmSync(generatedPath);
  return { authoredBytes, authoredPath, generatedBytes, generatedPath, root };
}

describe("manifest-generated plugin reference docs", () => {
  it("restores clean-checkout routes while preserving authored pages byte-for-byte", () => {
    const fixture = createPluginDocsFixture();

    expect(runGenerator(fixture.root, "--check").status).toBe(0);
    expect(readFileSync(fixture.generatedPath, "utf8")).toBe(fixture.generatedBytes);
    expect(readFileSync(fixture.authoredPath, "utf8")).toBe(fixture.authoredBytes);
    expect(renderDocsHeadingMap(path.join(fixture.root, "docs"))).toContain(
      "- Route: /plugins/reference/generated-example",
    );
  });

  it("rejects stale generated pages without overwriting evidence", () => {
    const fixture = createPluginDocsFixture();
    writeFileSync(
      fixture.generatedPath,
      fixture.generatedBytes.replace("generated-example plugin", "STALE generated-example plugin"),
    );

    const result = runGenerator(fixture.root, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated-example.md is stale");
    expect(readFileSync(fixture.generatedPath, "utf8")).toContain("STALE");
  });

  it("refuses to recreate missing authored content or hide newly authored sections", () => {
    const missingFixture = createPluginDocsFixture();
    rmSync(missingFixture.authoredPath);
    const missing = runGenerator(missingFixture.root, "--check");
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("missing its tracked, human-authored documentation");
    expect(existsSync(missingFixture.authoredPath)).toBe(false);

    const hiddenFixture = createPluginDocsFixture();
    writeFileSync(
      hiddenFixture.generatedPath,
      hiddenFixture.generatedBytes.replace(
        "## Surface\n\nplugin",
        `## Surface\n\nplugin\n\n${manualStart}\n\nDo not ignore me.\n\n${manualEnd}`,
      ),
    );
    const hidden = runGenerator(hiddenFixture.root, "--check");
    expect(hidden.status).not.toBe(0);
    expect(hidden.stderr).toContain("remove its .gitignore entry");
  });

  it("rejects future generated pages before any mode can dirty the source checkout", () => {
    const fixture = createPluginDocsFixture();
    const inventoryPath = path.join(fixture.root, "docs", "plugins", "plugin-inventory.md");
    const indexPath = path.join(fixture.root, "docs", "plugins", "reference.md");
    const inventoryBefore = readFileSync(inventoryPath, "utf8");
    const indexBefore = readFileSync(indexPath, "utf8");
    const futurePath = path.join(
      fixture.root,
      "docs",
      "plugins",
      "reference",
      "future-generated.md",
    );
    addFixturePlugin(fixture.root, "future-generated");

    for (const mode of ["--write", "--check", "--materialize"]) {
      const result = runGenerator(fixture.root, mode);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("future-generated.md is not explicitly listed in .gitignore");
      expect(existsSync(futurePath)).toBe(false);
      expect(existsSync(fixture.generatedPath)).toBe(false);
      expect(readFileSync(inventoryPath, "utf8")).toBe(inventoryBefore);
      expect(readFileSync(indexPath, "utf8")).toBe(indexBefore);
      expect(readFileSync(fixture.authoredPath, "utf8")).toBe(fixture.authoredBytes);
    }
  });

  it("keeps future human-authored reference pages visible and byte-identical", () => {
    const fixture = createPluginDocsFixture();
    addFixturePlugin(fixture.root, "future-authored");
    const relativePath = "docs/plugins/reference/future-authored.md";
    const authoredPath = path.join(fixture.root, relativePath);
    const authoredBytes = `## Surface\n\nplugin\n\n${manualStart}\n\nFuture operator guidance.\n\n${manualEnd}\n`;
    writeFileSync(authoredPath, authoredBytes);

    const init = spawnSync("git", ["init", "--quiet"], { cwd: fixture.root, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const ignored = spawnSync("git", ["check-ignore", "--no-index", relativePath], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(ignored.status).toBe(1);

    const result = runGenerator(fixture.root, "--write");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("add its plugin id to AUTHORED_REFERENCE_PAGE_IDS");
    expect(readFileSync(authoredPath, "utf8")).toBe(authoredBytes);
    expect(existsSync(fixture.generatedPath)).toBe(false);
  });

  it("materializes references before heading maps and no-lifecycle npm packaging", async () => {
    const fixture = createPluginDocsFixture();

    await expect(preparePackageDocsMap(fixture.root)).resolves.toBe(true);
    expect(readFileSync(fixture.generatedPath, "utf8")).toBe(fixture.generatedBytes);
    expect(readFileSync(path.join(fixture.root, "docs", "docs_map.md"), "utf8")).toContain(
      "- Route: /plugins/reference/generated-example",
    );

    if (process.platform !== "win32") {
      const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
        cwd: fixture.root,
        encoding: "utf8",
      });
      expect(packed.status, packed.stderr).toBe(0);
      const files =
        (JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>)[0]?.files ?? [];
      expect(files.map(({ path: filePath }) => filePath)).toContain(
        "docs/plugins/reference/generated-example.md",
      );
    }

    await expect(restorePackageDocsMap(fixture.root)).resolves.toBe(true);
    expect(readFileSync(fixture.authoredPath, "utf8")).toBe(fixture.authoredBytes);
  });

  it("keeps standalone docs roots and publish mirror scripts independent", () => {
    const docsRoot = tempDirs.make("openclaw-standalone-docs-");
    mkdirSync(path.join(docsRoot, "docs"));
    expect(materializePluginReferenceDocs(path.join(docsRoot, "docs"))).toBe(false);

    const workflow = readFileSync(
      path.join(repoRoot, ".github", "workflows", "docs-sync-publish.yml"),
      "utf8",
    );
    expect(workflow).toContain("extensions/**/openclaw.plugin.json");
    expect(workflow).toContain("extensions/**/package.json");
    expect(workflow).toContain("scripts/generate-plugin-inventory-doc.mjs");
    expect(workflow).toContain("scripts/lib/plugin-inventory-doc.mjs");
  });
});
