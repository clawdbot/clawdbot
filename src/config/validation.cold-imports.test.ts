import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("config validation cold imports", () => {
  it("keeps validation command-alias guidance on manifest metadata", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/config/validation.ts"), "utf8");

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*manifest-command-aliases\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*providers\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*loader\.js["']/);
  });
});
