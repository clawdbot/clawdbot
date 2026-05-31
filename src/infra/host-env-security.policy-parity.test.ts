import fs from "node:fs";
import path from "node:path";
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
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

describe("host env security policy parity", () => {
  it("keeps generated macOS host env policy in sync with shared JSON policy", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
    const generatedSwiftPath = path.join(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSecurityPolicy.generated.swift",
    );
    const sanitizerSwiftPath = path.join(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSanitizer.swift",
    );

    const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const policy = loadHostEnvSecurityPolicy(rawPolicy);
    const generatedSource = fs.readFileSync(generatedSwiftPath, "utf8");
    const sanitizerSource = fs.readFileSync(sanitizerSwiftPath, "utf8");

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
