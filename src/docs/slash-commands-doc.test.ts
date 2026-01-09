import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listChatCommands } from "../auto-reply/commands-registry.js";

function extractDocumentedSlashCommands(markdown: string): Set<string> {
  const documented = new Set<string>();
  for (const match of markdown.matchAll(/`\/(?!<)([a-z0-9_-]+)/gi)) {
    documented.add(`/${match[1]}`);
  }
  return documented;
}

describe("slash commands docs", () => {
  it("documents all built-in chat command aliases", async () => {
    const docPath = path.join(
      process.cwd(),
      "docs",
      "tools",
      "slash-commands.md",
    );
    const markdown = await fs.readFile(docPath, "utf8");
    const documented = extractDocumentedSlashCommands(markdown);

    for (const command of listChatCommands()) {
      for (const alias of command.textAliases) {
        expect(documented.has(alias)).toBe(true);
      }
    }
  });
});
