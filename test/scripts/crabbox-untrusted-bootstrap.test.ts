// Crabbox untrusted bootstrap tests cover the pre-execution identity boundary.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/crabbox-untrusted-bootstrap.sh", () => {
  it("bounds both IMDSv2 identity requests", () => {
    const script = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
    const imdsRequests = script.match(
      /\/usr\/bin\/curl[\s\S]*?http:\/\/169\.254\.169\.254[^\n]*/gu,
    );

    expect(imdsRequests).toHaveLength(2);
    for (const request of imdsRequests ?? []) {
      expect(request).toContain("--connect-timeout 2");
      expect(request).toContain("--max-time 5");
    }
  });
});
