// Crabbox untrusted bootstrap tests cover the pre-execution identity boundary.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/crabbox-untrusted-bootstrap.sh", () => {
  it("pins the package manager required by the trusted checkout", () => {
    const script = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      packageManager?: string;
    };
    const pnpmSpec = script.match(/^pnpm_spec="([^"]+)"$/mu)?.[1];

    expect(pnpmSpec).toBe(packageJson.packageManager);
    const warmup = script.indexOf('"$install_root/bin/corepack" "$pnpm_spec" --version');
    expect(warmup).toBeGreaterThan(script.indexOf('cd "$install_root"'));
    expect(warmup).toBeLessThan(script.indexOf("actual_package_manager="));
  });

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
