import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("search setup cold imports", () => {
  it("keeps configure wizard command registration off search provider runtime", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/commands/configure.wizard.ts"), "utf8");

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*onboard-search\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*web-search-providers\.runtime\.js["']/);
  });
});
