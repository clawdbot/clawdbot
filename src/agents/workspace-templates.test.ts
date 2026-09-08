/**
 * Regression coverage for workspace template directory discovery.
 * Verifies packaged and fallback documentation template search paths.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function loadWorkspaceTemplateResolvers() {
  vi.resetModules();
  return import("./workspace-templates.js");
}

describe("resolveWorkspaceTemplateSearchDirs", () => {
  it("resolves templates from package root when module url is dist-rooted", async () => {
    const { resolveWorkspaceTemplateSearchDirs } = await loadWorkspaceTemplateResolvers();
    const root = tempDirs.make("openclaw-templates-");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const templatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "AGENTS.md"), "# ok\n");

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    // The primary template dir is the first search root of the public resolver.
    const [resolved] = await resolveWorkspaceTemplateSearchDirs({ cwd: distDir, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });

  it("falls back to checkout docs when package-root templates are missing", async () => {
    const { resolveWorkspaceTemplateSearchDirs } = await loadWorkspaceTemplateResolvers();
    const root = tempDirs.make("openclaw-templates-");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const [resolved = ""] = await resolveWorkspaceTemplateSearchDirs({ cwd: distDir, moduleUrl });
    expect(path.normalize(resolved)).toBe(path.resolve("docs", "reference", "templates"));
  });

  it("returns only existing documentation template directories", async () => {
    const { resolveWorkspaceTemplateSearchDirs } = await loadWorkspaceTemplateResolvers();
    const root = tempDirs.make("openclaw-templates-");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const docsTemplatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(docsTemplatesDir, { recursive: true });

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateSearchDirs({ cwd: distDir, moduleUrl });
    expect(resolved[0]).toBe(docsTemplatesDir);
    expect(resolved).not.toContain(path.join(root, "src", "agents", "templates"));
    for (const templateDir of resolved) {
      expect((await fs.stat(templateDir)).isDirectory()).toBe(true);
    }
  });

  it("does not ship a retired runtime heartbeat template", async () => {
    const heartbeatTemplate = path.resolve("src", "agents", "templates", "HEARTBEAT.md");

    await expect(fs.access(heartbeatTemplate)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
