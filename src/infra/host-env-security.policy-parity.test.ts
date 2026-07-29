// Tests host environment security policy parity with documented rules.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { describe, expect, it } from "vitest";
import { loadHostEnvSecurityPolicy } from "./host-env-security-policy.js";

function parseSwiftStringArray(source: string, marker: string): string[] {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedMarker}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = source.match(re);
  if (!match) {
    throw new Error(`Failed to parse Swift array for marker: ${marker}`);
  }
  const arrayBody = expectDefined(match[1], `Swift array body for ${marker}`);
  return Array.from(arrayBody.matchAll(/"([^"]+)"/g), (entry) =>
    expectDefined(entry[1], `Swift array entry for ${marker}`),
  );
}

function readRepoFile(repoRoot: string, relativePath: string): string {
  try {
    return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Sparse worktrees may omit app sources, but the tracked blob is still the parity source.
  return execFileSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("host env security policy parity", () => {
  it("keeps generated macOS host env policy in sync with shared JSON policy", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");

    const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const policy = loadHostEnvSecurityPolicy(rawPolicy);
    const generatedSource = readRepoFile(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSecurityPolicy.generated.swift",
    );
    const sanitizerSource = readRepoFile(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSanitizer.swift",
    );

    const swiftBlockedKeys = parseSwiftStringArray(generatedSource, "static let blockedKeys");
    const swiftBlockedInheritedKeys = parseSwiftStringArray(
      generatedSource,
      "static let blockedInheritedKeys",
    );
    const swiftBlockedInheritedPrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedInheritedPrefixes",
    );
    const swiftBlockedOverrideKeys = parseSwiftStringArray(
      generatedSource,
      "static let blockedOverrideKeys",
    );
    const swiftBlockedOverridePrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedOverridePrefixes",
    );
    const swiftBlockedPrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedPrefixes",
    );

    expect(swiftBlockedInheritedKeys).toEqual(policy.blockedInheritedKeys);
    expect(swiftBlockedInheritedPrefixes).toEqual(policy.blockedInheritedPrefixes ?? []);
    expect(swiftBlockedKeys).toEqual(policy.blockedKeys);
    expect(swiftBlockedOverrideKeys).toEqual(policy.blockedOverrideKeys ?? []);
    expect(swiftBlockedOverridePrefixes).toEqual(policy.blockedOverridePrefixes ?? []);
    expect(swiftBlockedPrefixes).toEqual(policy.blockedPrefixes);

    expect(sanitizerSource).toContain(
      "private static let blockedInheritedKeys = HostEnvSecurityPolicy.blockedInheritedKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedInheritedPrefixes = HostEnvSecurityPolicy.blockedInheritedPrefixes",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedKeys = HostEnvSecurityPolicy.blockedKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedOverrideKeys = HostEnvSecurityPolicy.blockedOverrideKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedOverridePrefixes = HostEnvSecurityPolicy.blockedOverridePrefixes",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedPrefixes = HostEnvSecurityPolicy.blockedPrefixes",
    );
  });

  it("derives inherited and override lists from explicit policy buckets", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
    const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const policy = loadHostEnvSecurityPolicy(rawPolicy);
    const allowedInheritedOverrideOnlyKeys = new Set(
      (rawPolicy.allowedInheritedOverrideOnlyKeys ?? []).map((value: string) =>
        value.toUpperCase(),
      ),
    );

    expect(policy.blockedKeys).toEqual(sortUniqueStrings([...policy.blockedEverywhereKeys]));
    expect(policy.blockedOverrideKeys).toEqual(
      sortUniqueStrings([...policy.blockedOverrideOnlyKeys]),
    );
    expect(policy.blockedInheritedKeys).toEqual(
      sortUniqueStrings([
        ...policy.blockedEverywhereKeys,
        ...policy.blockedOverrideOnlyKeys.filter(
          (value) => !allowedInheritedOverrideOnlyKeys.has(value.toUpperCase()),
        ),
      ]),
    );
    expect(policy.blockedInheritedPrefixes).toEqual(
      sortUniqueStrings(rawPolicy.blockedInheritedPrefixes ?? rawPolicy.blockedPrefixes ?? []),
    );
  });
});
