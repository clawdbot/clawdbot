import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyConfigRules } from "../doctor-contract-api.js";
import { MAX_SANDBOX_POLICY_FILE_BYTES } from "../src/sandbox-policy-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("mxc doctor contract", () => {
  it("warns before upgrade for oversized policy files without mutating config", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-mxc-doctor-"));
    tempDirs.push(dir);
    const smallPath = join(dir, "small.json");
    const oversizedPath = join(dir, "oversized.json");
    writeFileSync(smallPath, "{}", "utf8");
    writeFileSync(oversizedPath, Buffer.alloc(MAX_SANDBOX_POLICY_FILE_BYTES + 1, 0x20));

    const rule = legacyConfigRules[0];
    expect(rule).toBeDefined();
    const policyPaths = [smallPath, oversizedPath];

    expect(rule?.match?.(policyPaths, {})).toBe(true);
    expect(policyPaths).toEqual([smallPath, oversizedPath]);
    expect(rule?.match?.([smallPath], {})).toBe(false);
    expect(rule?.match?.([join(dir, "missing.json")], {})).toBe(false);
    expect(rule?.message).toContain("before upgrading");
    expect(rule?.message).toContain("1 MiB or less");
  });
});
