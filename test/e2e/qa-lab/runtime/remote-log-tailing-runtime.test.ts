import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("remote log tailing scenario", () => {
  it("declares packaged CLI, RPC bounds, cursor, follow, and owned SIGINT proof", () => {
    const source = readFileSync(
      path.join(process.cwd(), "test/e2e/qa-lab/runtime/remote-log-tailing-runtime.ts"),
      "utf8",
    );
    expect(source).toContain('"logs.tail"');
    expect(source).toContain("first.cursor");
    expect(source).toContain('"--max-bytes"');
    expect(source).toContain('"--follow"');
    expect(source).toContain('child.kill("SIGINT")');
    expect(source).toContain('path.join(repoRoot, "dist", "index.js")');
  });
});
