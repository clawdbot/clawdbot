import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/release-scenarios/assertions.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(args: string[]) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
  });
}

describe("release scenario assertions", () => {
  it("passes when the installed package version matches the candidate version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const packageRoot = path.join(root, "openclaw");

    try {
      writeJson(path.join(packageRoot, "package.json"), {
        name: "openclaw",
        version: "2026.5.26",
      });

      const result = runAssertion([
        "assert-package-version",
        packageRoot,
        "2026.5.26",
        "candidate",
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails when the global install still points at the baseline version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-scenarios-"));
    const packageRoot = path.join(root, "openclaw");

    try {
      writeJson(path.join(packageRoot, "package.json"), {
        name: "openclaw",
        version: "2026.5.22",
      });

      const result = runAssertion([
        "assert-package-version",
        packageRoot,
        "2026.5.26",
        "candidate",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "candidate package version mismatch: expected 2026.5.26, got 2026.5.22",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
