#!/usr/bin/env node
// Generates Swift constants for the host environment security policy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostEnvSecurityPolicy } from "../src/infra/host-env-security-policy.js";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write") || !checkOnly;

if (checkOnly && args.has("--write")) {
  console.error("Use either --check or --write, not both.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const policyPath = path.join(repoRoot, "src", "infra", "host-env-security-policy.json");
const outputPath = path.join(
  repoRoot,
  "apps",
  "macos",
  "Sources",
  "OpenClaw",
  "HostEnvSecurityPolicy.generated.swift",
);

const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const policy = loadHostEnvSecurityPolicy(rawPolicy);

const renderSwiftStringArray = (items) => items.map((item) => `        "${item}"`).join(",\n");

const generated = `// Generated file. Do not edit directly.
// Source: src/infra/host-env-security-policy.json
// Regenerate: node scripts/generate-host-env-security-policy-swift.mjs --write

import Foundation

enum HostEnvSecurityPolicy {
    static let blockedInheritedKeys: Set<String> = [
${renderSwiftStringArray(policy.blockedInheritedKeys)}
    ]

    static let blockedInheritedPrefixes: [String] = [
${renderSwiftStringArray(policy.blockedInheritedPrefixes)}
    ]

    static let blockedKeys: Set<String> = [
${renderSwiftStringArray(policy.blockedKeys)}
    ]

    static let blockedOverrideKeys: Set<String> = [
${renderSwiftStringArray(policy.blockedOverrideKeys ?? [])}
    ]

    static let blockedOverridePrefixes: [String] = [
${renderSwiftStringArray(policy.blockedOverridePrefixes ?? [])}
    ]

    static let blockedPrefixes: [String] = [
${renderSwiftStringArray(policy.blockedPrefixes)}
    ]
}
`;

const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;

if (checkOnly) {
  if (current === generated) {
    console.log(`OK ${path.relative(repoRoot, outputPath)}`);
    process.exit(0);
  }
  console.error(
    [
      `Out of date ${path.relative(repoRoot, outputPath)}.`,
      "Run: node scripts/generate-host-env-security-policy-swift.mjs --write",
    ].join("\n"),
  );
  process.exit(1);
}

if (writeMode) {
  if (current !== generated) {
    fs.writeFileSync(outputPath, generated);
  }
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}
