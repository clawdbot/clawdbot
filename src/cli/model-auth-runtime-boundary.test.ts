import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("model auth runtime boundary", () => {
  it("keeps capability CLI command registration off the models auth runtime", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/cli/capability-cli.ts"), "utf8");

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*commands\/models\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*commands\/models\/auth\.js["']/);
    expect(source).toMatch(/\bawait\s+import\(["'][^"']*commands\/models\/auth\.js["']\)/);
  });
});
