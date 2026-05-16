import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";

const PLUGIN_DOCS_DIR = path.join(process.cwd(), "docs", "plugins");

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function listMarkdownFiles(dir: string): string[] {
  const externalFiles = listExternalMarkdownFiles(dir);
  if (externalFiles) {
    return externalFiles;
  }
  return walkMarkdownFiles(dir);
}

function listExternalMarkdownFiles(dir: string): string[] | null {
  const repoPath = path.relative(process.cwd(), dir).split(path.sep).join("/");
  return listGitMarkdownFiles(repoPath) ?? listFindMarkdownFiles(dir);
}

function listGitMarkdownFiles(repoPath: string): string[] | null {
  const result = spawnSync("git", ["ls-files", "--", repoPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".md"))
    .map((filePath) => path.join(process.cwd(), filePath))
    .toSorted();
}

function listFindMarkdownFiles(dir: string): string[] | null {
  const result = spawnSync("find", [dir, "-type", "f", "-name", "*.md"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted();
}

function walkMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("plugin docs examples", () => {
  it("lists plugin docs without scanning directories in-process", () => {
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      const files = listMarkdownFiles(PLUGIN_DOCS_DIR);

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((filePath) => filePath.endsWith(".md"))).toBe(true);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
  });

  it("keeps plugin docs JSON fences parseable", () => {
    const failures: string[] = [];
    for (const docPath of listMarkdownFiles(PLUGIN_DOCS_DIR)) {
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = markdown.matchAll(/```(json5|json)\n([\s\S]*?)```/g);
      for (const match of blocks) {
        const lang = match[1] ?? "";
        const code = match[2] ?? "";
        const relativePath = path.relative(process.cwd(), docPath).split(path.sep).join("/");
        const location = `${relativePath}:${lineNumberAt(markdown, match.index ?? 0)}`;
        try {
          if (lang === "json") {
            JSON.parse(code);
          } else {
            JSON5.parse(code);
          }
        } catch (error) {
          failures.push(`${location} ${lang.toUpperCase()} parse failed: ${String(error)}`);
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });
});
