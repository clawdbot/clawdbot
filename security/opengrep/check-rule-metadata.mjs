#!/usr/bin/env node
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";

const DEFAULT_RULEPACK = path.resolve("security", "opengrep", "precise.yml");
const GHSA_RE = /^GHSA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const RULE_ID_RE = /^([a-z0-9][a-z0-9_-]*)\..+$/;

function printHelp() {
  console.log(`Usage: node security/opengrep/check-rule-metadata.mjs [rulepack.yml]

Checks that every compiled OpenGrep rule carries source/provenance metadata.
Default rulepack: ${DEFAULT_RULEPACK}
`);
}

export async function readRules(rulepackPath) {
  const raw = await fs.readFile(rulepackPath, "utf8");
  const doc = parseDocument(raw, { keepSourceTokens: false });
  if (doc.errors.length > 0) {
    throw new Error(
      `Could not parse ${rulepackPath}: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const data = doc.toJSON();
  if (!data || !Array.isArray(data.rules)) {
    throw new Error(`${rulepackPath} must contain a top-level rules array`);
  }
  return data.rules;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeIdComponent(value) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "rule"
  );
}

function sanitizeSourceIdComponent(value) {
  return sanitizeIdComponent(value).replace(/[.]+/g, "-");
}

export function validateRuleMetadata(rules) {
  const violations = [];

  for (const [index, rule] of rules.entries()) {
    const id = String(rule?.id ?? "");
    const label = id || `rules[${index}]`;
    const metadata = rule?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      violations.push(`${label}: missing metadata object`);
      continue;
    }

    const idMatch = id.match(RULE_ID_RE);
    if (!idMatch) {
      violations.push(`${label}: id must match <source-id>.<source-rule-id>`);
    }

    const ghsa = String(metadata.ghsa ?? "");
    const advisoryId = String(metadata["advisory-id"] ?? metadata.ghsa ?? "")
      .trim()
      .toUpperCase();
    if (!hasNonEmptyString(advisoryId)) {
      violations.push(`${label}: missing metadata.advisory-id or metadata.ghsa`);
    } else if (idMatch && idMatch[1] !== sanitizeSourceIdComponent(advisoryId)) {
      violations.push(
        `${label}: source id in metadata (${advisoryId}) must match source id in rule id (${idMatch[1]})`,
      );
    }

    if (ghsa && !GHSA_RE.test(ghsa)) {
      violations.push(`${label}: metadata.ghsa must match GHSA-XXXX-XXXX-XXXX when present`);
    } else if (ghsa && advisoryId !== ghsa) {
      violations.push(
        `${label}: metadata.advisory-id must match metadata.ghsa when both are present`,
      );
    }

    const advisoryUrl = String(metadata["advisory-url"] ?? "");
    const expectedGhsaUrl = GHSA_RE.test(advisoryId)
      ? `https://github.com/openclaw/openclaw/security/advisories/${advisoryId}`
      : "";
    if (!hasNonEmptyString(advisoryUrl)) {
      violations.push(`${label}: missing metadata.advisory-url`);
    } else if (expectedGhsaUrl && advisoryUrl !== expectedGhsaUrl) {
      violations.push(`${label}: metadata.advisory-url must be ${expectedGhsaUrl}`);
    }

    if (metadata["detector-bucket"] !== "precise") {
      violations.push(`${label}: metadata.detector-bucket must be precise`);
    }
    if (!hasNonEmptyString(metadata["source-rule-id"])) {
      violations.push(`${label}: missing metadata.source-rule-id`);
    }
  }

  return violations;
}

export async function checkRulepack(rulepackPath = DEFAULT_RULEPACK) {
  const rules = await readRules(rulepackPath);
  return validateRuleMetadata(rules);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  const rulepackPath = path.resolve(argv[0] ?? DEFAULT_RULEPACK);
  const violations = await checkRulepack(rulepackPath);
  if (violations.length > 0) {
    console.error(
      `check-opengrep-rule-metadata: ${violations.length} violation(s) in ${rulepackPath}`,
    );
    for (const violation of violations.slice(0, 50)) {
      console.error(`  - ${violation}`);
    }
    if (violations.length > 50) {
      console.error(`  ... ${violations.length - 50} more`);
    }
    return 1;
  }
  console.log(`check-opengrep-rule-metadata: ${rulepackPath} ok`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
