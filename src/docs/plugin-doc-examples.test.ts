import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";

const PLUGIN_DOCS_DIR = path.join(process.cwd(), "docs", "plugins");

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function listMarkdownFiles(dir: string): string[] {
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
    expect(failures).toEqual([]);
  });
});
