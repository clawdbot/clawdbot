import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isHeartbeatContentEffectivelyEmpty } from "../auto-reply/heartbeat.js";
import {
  resetWorkspaceTemplateDirCache,
  resolveWorkspaceTemplateDir,
  resolveWorkspaceTemplateSearchDirs,
} from "./workspace-templates.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-templates-"));
  tempDirs.push(root);
  return root;
}

describe("resolveWorkspaceTemplateDir", () => {
  afterEach(async () => {
    resetWorkspaceTemplateDirCache();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("resolves templates from package root when module url is dist-rooted", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const templatesDir = path.join(root, "src", "agents", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "HEARTBEAT.md"), "# ok\n");

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: distDir, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });

  it("falls back to package-root runtime path when templates directory is missing", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: distDir, moduleUrl });
    expect(path.normalize(resolved)).toBe(path.resolve("src", "agents", "templates"));
  });

  it("includes docs templates as secondary search roots", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const runtimeTemplatesDir = path.join(root, "src", "agents", "templates");
    const docsTemplatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(runtimeTemplatesDir, { recursive: true });
    await fs.mkdir(docsTemplatesDir, { recursive: true });

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateSearchDirs({ cwd: distDir, moduleUrl });
    expect(resolved.slice(0, 2)).toEqual([runtimeTemplatesDir, docsTemplatesDir]);
  });

  it("keeps runtime templates free of docs frontmatter", async () => {
    const runtimeTemplatesDir = path.resolve("src", "agents", "templates");
    const entries = await fs.readdir(runtimeTemplatesDir);
    const markdownFiles = entries.filter((entry) => entry.endsWith(".md"));

    expect(markdownFiles).toContain("HEARTBEAT.md");
    for (const fileName of markdownFiles) {
      const content = await fs.readFile(path.join(runtimeTemplatesDir, fileName), "utf-8");
      expect(content.startsWith("---")).toBe(false);
    }
  });

  it("keeps the runtime HEARTBEAT.md template effectively empty", async () => {
    const runtimeTemplatesDir = path.resolve("src", "agents", "templates");
    const content = await fs.readFile(path.join(runtimeTemplatesDir, "HEARTBEAT.md"), "utf-8");

    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(true);
  });
});
