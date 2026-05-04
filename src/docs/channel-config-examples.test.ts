import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";

const CHANNEL_DOCS_DIR = path.join(process.cwd(), "docs", "channels");

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

describe("channel docs config examples", () => {
  it("keeps channel docs JSON fences parseable", () => {
    const failures: string[] = [];
    for (const fileName of fs
      .readdirSync(CHANNEL_DOCS_DIR)
      .filter((entry) => entry.endsWith(".md"))) {
      const docPath = path.join(CHANNEL_DOCS_DIR, fileName);
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
    expect(failures).toEqual([]);
  });

  it("keeps OpenClaw channel config snippets parseable and schema-valid", () => {
    const failures: string[] = [];
    for (const fileName of fs
      .readdirSync(CHANNEL_DOCS_DIR)
      .filter((entry) => entry.endsWith(".md"))) {
      const docPath = path.join(CHANNEL_DOCS_DIR, fileName);
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
    expect(failures).toEqual([]);
  });
});
