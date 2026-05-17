import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";

const CHANNEL_DOCS_DIR = path.join(process.cwd(), "docs", "channels");

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function listChannelDocFiles(): string[] {
  const externalFiles = listExternalChannelDocFiles();
  if (externalFiles) {
    return externalFiles;
  }
  return fs
    .readdirSync(CHANNEL_DOCS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((fileName) => path.join(CHANNEL_DOCS_DIR, fileName))
    .toSorted();
}

function listExternalChannelDocFiles(): string[] | null {
  return listGitChannelDocFiles() ?? listFindChannelDocFiles();
}

function listGitChannelDocFiles(): string[] | null {
  const files = listGitTrackedFiles({ pathspecs: "docs/channels/*.md" });
  if (!files) {
    return null;
  }
  return files.map((filePath) => path.join(process.cwd(), filePath)).toSorted();
}

function listFindChannelDocFiles(): string[] | null {
  const result = spawnSync(
    "find",
    [CHANNEL_DOCS_DIR, "-maxdepth", "1", "-type", "f", "-name", "*.md"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted();
}

describe("channel docs config examples", () => {
  it("lists channel docs without scanning the docs directory in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listChannelDocFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((filePath) => filePath.endsWith(".md"))).toBe(true);
    });
  });

  it("keeps channel docs JSON fences parseable", () => {
    const failures: string[] = [];
    for (const docPath of listChannelDocFiles()) {
      const fileName = path.basename(docPath);
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = markdown.matchAll(/```(?:json5|json)\n([\s\S]*?)```/g);
      for (const match of blocks) {
        const code = match[1] ?? "";
        const location = `${fileName}:${lineNumberAt(markdown, match.index ?? 0)}`;
        const isStrictJson = match[0].startsWith("```json\n");
        try {
          if (isStrictJson) {
            JSON.parse(code);
          } else {
            JSON5.parse(code);
          }
        } catch (error) {
          failures.push(
            `${location} ${isStrictJson ? "JSON" : "JSON5"} parse failed: ${String(error)}`,
          );
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });

  it("keeps OpenClaw channel config snippets parseable and schema-valid", () => {
    const failures: string[] = [];
    for (const docPath of listChannelDocFiles()) {
      const fileName = path.basename(docPath);
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = markdown.matchAll(/```(?:json5|json)\n([\s\S]*?)```/g);
      for (const match of blocks) {
        const code = match[1] ?? "";
        if (!/(^|\n)\s*(?:"channels"|channels)\s*:/.test(code)) {
          continue;
        }
        const location = `${fileName}:${lineNumberAt(markdown, match.index ?? 0)}`;
        let parsed: unknown;
        try {
          parsed = JSON5.parse(code);
        } catch (error) {
          failures.push(`${location} JSON5 parse failed: ${String(error)}`);
          continue;
        }
        const result = OpenClawSchema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ");
          failures.push(`${location} schema failed: ${issues}`);
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });
});
