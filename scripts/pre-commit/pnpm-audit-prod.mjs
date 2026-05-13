#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const BULK_ADVISORY_PATH = "/-/npm/v1/security/advisories/bulk";
const MIN_SEVERITY = "high";
const SEVERITY_RANK = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
const TOP_LEVEL_INDENT = 0;
const SECTION_ENTRY_INDENT = 2;
const NESTED_SECTION_INDENT = 4;
const MAPPING_ENTRY_INDENT = 6;
const NESTED_MAPPING_ENTRY_INDENT = 8;
const SNAPSHOT_SECTIONS = ["dependencies", "optionalDependencies"];
const IMPORTER_SECTIONS = ["dependencies", "optionalDependencies"];
const LOCAL_REFERENCE_PREFIXES = ["file:", "link:", "portal:", "workspace:"];
// GitHub's GHSA-3q49-cfcf-g5fm feed includes an overbroad ">=0" range alongside
// the compromised @mistralai/mistralai versions. Keep the production audit
// blocking for the compromised releases while allowing our pinned 2.2.1 lock.
const AUDIT_ADVISORY_VERSION_OVERRIDES = [
  {
    packageName: "@mistralai/mistralai",
    advisoryIds: new Set(["1118204", "GHSA-3q49-cfcf-g5fm"]),
    unaffectedVersions: new Set(["2.2.1"]),
  },
];

export function normalizeAuditLevel(level) {
  const normalized = String(level ?? "").toLowerCase();
  if (normalized in SEVERITY_RANK) {
    return normalized;
  }
  throw new Error(
    `Unsupported audit level "${String(level)}". Expected one of: ${Object.keys(SEVERITY_RANK).join(", ")}`,
  );
}

export function stripVersionDecorators(reference) {
  const openParenIndex = reference.indexOf("(");
  if (openParenIndex === -1) {
    return reference;
  }
  return reference.slice(0, openParenIndex);
}

export function parseSnapshotKey(snapshotKey) {
  let separatorIndex = -1;
  let parenDepth = 0;
  for (let index = 1; index < snapshotKey.length; index += 1) {
    const character = snapshotKey[index];
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === "@" && parenDepth === 0) {
      separatorIndex = index;
    }
  }
  if (separatorIndex <= 0) {
    throw new Error(`Unable to parse pnpm snapshot key "${snapshotKey}".`);
  }
  const packageName = snapshotKey.slice(0, separatorIndex);
  const reference = snapshotKey.slice(separatorIndex + 1);
  return {
    packageName,
    reference,
    version: stripVersionDecorators(reference),
  };
}

function isLocalReference(reference) {
  return LOCAL_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

function countIndentation(line) {
  let indentation = 0;
  while (indentation < line.length && line[indentation] === " ") {
    indentation += 1;
  }
  return indentation;
}

function isIgnorableYamlLine(trimmed) {
  return !trimmed || trimmed.startsWith("#");
}

function unquoteYamlString(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

function parseYamlScalar(value) {
  return unquoteYamlString(value.trim());
}

function splitInlineYamlMapEntries(text) {
  const entries = [];
  let current = "";
  let quote = null;
  let depth = 0;

  for (const character of text) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth = Math.max(0, depth - 1);
      current += character;
      continue;
    }
    if (character === "," && depth === 0) {
      const entry = current.trim();
      if (entry) {
        entries.push(entry);
      }
      current = "";
      continue;
    }
    current += character;
  }

  const entry = current.trim();
  if (entry) {
    entries.push(entry);
  }
  return entries;
}

function parseInlineYamlMap(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return {};
  }

  const result = {};
  for (const entry of splitInlineYamlMapEntries(body)) {
    const mapping = parseYamlMappingLine(entry);
    if (!mapping?.value) {
      continue;
    }
    result[mapping.key] = parseYamlScalar(mapping.value);
  }
  return result;
}

function findYamlMappingSeparator(line) {
  let quote = null;
  let depth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character !== ":" || depth !== 0) {
      continue;
    }

    const nextCharacter = line[index + 1];
    if (nextCharacter === undefined || /\s/u.test(nextCharacter)) {
      return index;
    }
  }

  return -1;
}

function parseYamlMappingLine(line) {
  const separatorIndex = findYamlMappingSeparator(line);
  if (separatorIndex === -1) {
    return null;
  }
  return {
    key: parseYamlScalar(line.slice(0, separatorIndex)),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function isNamedYamlSection(trimmed, sectionNames) {
  return sectionNames.some((sectionName) => trimmed === `${sectionName}:`);
}

function readNestedVersionValue(lines, startIndex, parentIndent) {
  let index = startIndex;
  let version = null;

  while (index < lines.length) {
    const nestedLine = lines[index];
    const nestedTrimmed = nestedLine.trim();
    const nestedIndentation = countIndentation(nestedLine);
    if (isIgnorableYamlLine(nestedTrimmed)) {
      index += 1;
      continue;
    }
    if (nestedIndentation <= parentIndent) {
      break;
    }
    if (nestedIndentation === NESTED_MAPPING_ENTRY_INDENT) {
      const nestedEntry = parseYamlMappingLine(nestedTrimmed);
      if (nestedEntry?.key === "version") {
        version = parseYamlScalar(nestedEntry.value);
      }
    }
    index += 1;
  }

  return { nextIndex: index, version };
}

function collectIndentedStringMap(lines, startIndex, entryIndent) {
  const entries = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const indentation = countIndentation(line);

    if (isIgnorableYamlLine(trimmed)) {
      index += 1;
      continue;
    }
    if (indentation < entryIndent) {
      break;
    }
    if (indentation !== entryIndent) {
      index += 1;
      continue;
    }

    const entry = parseYamlMappingLine(trimmed);
    if (entry?.value) {
      entries[entry.key] = parseYamlScalar(entry.value);
    }
    index += 1;
  }

  return { entries, nextIndex: index };
}

function collectImporterDependencyReferences(lines, startIndex) {
  const references = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const indentation = countIndentation(line);

    if (isIgnorableYamlLine(trimmed)) {
      index += 1;
      continue;
    }
    if (indentation < MAPPING_ENTRY_INDENT) {
      break;
    }
    if (indentation > MAPPING_ENTRY_INDENT) {
      index += 1;
      continue;
    }

    const entry = parseYamlMappingLine(trimmed);
    index += 1;
    if (!entry) {
      continue;
    }

    if (entry.value) {
      const inlineMap = parseInlineYamlMap(entry.value);
      if (inlineMap && typeof inlineMap.version === "string") {
        references.push({ dependencyName: entry.key, reference: inlineMap.version });
        continue;
      }
      references.push({ dependencyName: entry.key, reference: parseYamlScalar(entry.value) });
      continue;
    }

    const nestedVersion = readNestedVersionValue(lines, index, MAPPING_ENTRY_INDENT);
    index = nestedVersion.nextIndex;
    if (nestedVersion.version) {
      references.push({ dependencyName: entry.key, reference: nestedVersion.version });
    }
  }

  return {
    nextIndex: index,
    references,
  };
}

function collectSnapshotDependencies(lines, startIndex) {
  const result = collectIndentedStringMap(lines, startIndex, MAPPING_ENTRY_INDENT);
  return { dependencies: result.entries, nextIndex: result.nextIndex };
}

function parsePnpmLockfileSections(lockfileText) {
  // Keep this parser dependency-free: security-fast runs this hook without pnpm install.
  // It only needs the small pnpm-lock subset used to collect production snapshots.
  const importers = [];
  const snapshots = {};
  const lines = lockfileText.split(/\r?\n/u);
  let currentTopLevelSection = null;
  let hasImportersSection = false;
  let hasSnapshotsSection = false;

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    const trimmed = line.trim();
    const indentation = countIndentation(line);

    if (isIgnorableYamlLine(trimmed)) {
      index += 1;
      continue;
    }

    if (indentation === TOP_LEVEL_INDENT && trimmed.endsWith(":")) {
      currentTopLevelSection = parseYamlScalar(trimmed.slice(0, -1));
      if (currentTopLevelSection === "importers") {
        hasImportersSection = true;
      }
      if (currentTopLevelSection === "snapshots") {
        hasSnapshotsSection = true;
      }
      index += 1;
      continue;
    }

    if (
      currentTopLevelSection === "importers" &&
      indentation === SECTION_ENTRY_INDENT &&
      trimmed.endsWith(":")
    ) {
      index += 1;
      while (index < lines.length) {
        const nestedLine = lines[index];
        const nestedTrimmed = nestedLine.trim();
        const nestedIndentation = countIndentation(nestedLine);

        if (isIgnorableYamlLine(nestedTrimmed)) {
          index += 1;
          continue;
        }
        if (nestedIndentation <= SECTION_ENTRY_INDENT) {
          break;
        }
        if (
          nestedIndentation === NESTED_SECTION_INDENT &&
          isNamedYamlSection(nestedTrimmed, IMPORTER_SECTIONS)
        ) {
          const result = collectImporterDependencyReferences(lines, index + 1);
          importers.push(...result.references);
          index = result.nextIndex;
          continue;
        }
        index += 1;
      }
      continue;
    }

    if (currentTopLevelSection === "snapshots" && indentation === SECTION_ENTRY_INDENT) {
      const snapshotEntry = parseYamlMappingLine(trimmed);
      if (!snapshotEntry) {
        index += 1;
        continue;
      }
      if (snapshotEntry.value) {
        snapshots[snapshotEntry.key] = {};
        index += 1;
        continue;
      }

      const snapshotKey = snapshotEntry.key;
      const snapshot = {};
      index += 1;
      while (index < lines.length) {
        const nestedLine = lines[index];
        const nestedTrimmed = nestedLine.trim();
        const nestedIndentation = countIndentation(nestedLine);

        if (isIgnorableYamlLine(nestedTrimmed)) {
          index += 1;
          continue;
        }
        if (nestedIndentation <= SECTION_ENTRY_INDENT) {
          break;
        }
        if (
          nestedIndentation === NESTED_SECTION_INDENT &&
          isNamedYamlSection(nestedTrimmed, SNAPSHOT_SECTIONS)
        ) {
          const result = collectSnapshotDependencies(lines, index + 1);
          snapshot[nestedTrimmed.slice(0, -1)] = result.dependencies;
          index = result.nextIndex;
          continue;
        }
        index += 1;
      }
      snapshots[snapshotKey] = snapshot;
      continue;
    }

    index += 1;
  }

  return { hasImportersSection, hasSnapshotsSection, importers, snapshots };
}

function resolveSnapshot({ dependencyName, reference, snapshots }) {
  if (isLocalReference(reference)) {
    return null;
  }

  const directKey = `${dependencyName}@${reference}`;
  if (directKey in snapshots) {
    return {
      snapshotKey: directKey,
      ...parseSnapshotKey(directKey),
    };
  }

  if (reference in snapshots) {
    return {
      snapshotKey: reference,
      ...parseSnapshotKey(reference),
    };
  }

  if (reference.startsWith("npm:")) {
    const aliasKey = reference.slice(4);
    if (aliasKey in snapshots) {
      return {
        snapshotKey: aliasKey,
        ...parseSnapshotKey(aliasKey),
      };
    }
  }

  throw new Error(
    `Unable to resolve pnpm snapshot for dependency "${dependencyName}" with reference "${reference}".`,
  );
}

export function collectProdResolvedPackagesFromLockfile(lockfileText) {
  const lockfile = parsePnpmLockfileSections(lockfileText);
  if (!lockfile.hasImportersSection) {
    throw new Error("pnpm-lock.yaml is missing the importers section.");
  }
  if (!lockfile.hasSnapshotsSection) {
    throw new Error("pnpm-lock.yaml is missing the snapshots section.");
  }

  const versionsByPackage = new Map();
  const seenSnapshots = new Set();
  const queue = [...lockfile.importers];

  while (queue.length > 0) {
    const next = queue.pop();
    if (!next) {
      continue;
    }
    const resolved = resolveSnapshot({
      dependencyName: next.dependencyName,
      reference: next.reference,
      snapshots: lockfile.snapshots,
    });
    if (!resolved) {
      continue;
    }

    let versions = versionsByPackage.get(resolved.packageName);
    if (!versions) {
      versions = new Set();
      versionsByPackage.set(resolved.packageName, versions);
    }
    versions.add(resolved.version);

    if (seenSnapshots.has(resolved.snapshotKey)) {
      continue;
    }
    seenSnapshots.add(resolved.snapshotKey);

    const snapshot = lockfile.snapshots[resolved.snapshotKey];
    if (!snapshot || typeof snapshot !== "object") {
      continue;
    }
    for (const sectionName of SNAPSHOT_SECTIONS) {
      const dependencies = snapshot[sectionName];
      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }
      for (const [dependencyName, reference] of Object.entries(dependencies)) {
        if (typeof reference !== "string") {
          continue;
        }
        queue.push({ dependencyName, reference });
      }
    }
  }

  return versionsByPackage;
}

export function collectAllResolvedPackagesFromLockfile(lockfileText) {
  const lockfile = parsePnpmLockfileSections(lockfileText);
  if (!lockfile.hasSnapshotsSection) {
    throw new Error("pnpm-lock.yaml is missing the snapshots section.");
  }

  const versionsByPackage = new Map();
  for (const snapshotKey of Object.keys(lockfile.snapshots)) {
    const resolved = parseSnapshotKey(snapshotKey);
    let versions = versionsByPackage.get(resolved.packageName);
    if (!versions) {
      versions = new Set();
      versionsByPackage.set(resolved.packageName, versions);
    }
    versions.add(resolved.version);
  }

  return versionsByPackage;
}

export function createBulkAdvisoryPayload(versionsByPackage) {
  return Object.fromEntries(
    [...versionsByPackage.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([packageName, versions]) => [
        packageName,
        [...versions].toSorted((left, right) => left.localeCompare(right)),
      ]),
  );
}

function normalizeSeverity(severity) {
  if (typeof severity !== "string") {
    return "info";
  }
  return severity.toLowerCase();
}

function advisoryMatchesOverride(advisory, override) {
  const advisoryId = String(advisory?.id ?? "");
  const advisoryUrl = typeof advisory?.url === "string" ? advisory.url : "";
  return (
    override.advisoryIds.has(advisoryId) ||
    [...override.advisoryIds].some((id) => advisoryUrl.includes(id))
  );
}

function shouldSuppressAdvisoryFinding({ packageName, advisory, versionsByPackage }) {
  if (!versionsByPackage) {
    return false;
  }
  const override = AUDIT_ADVISORY_VERSION_OVERRIDES.find(
    (candidate) =>
      candidate.packageName === packageName && advisoryMatchesOverride(advisory, candidate),
  );
  if (!override) {
    return false;
  }
  const resolvedVersions = versionsByPackage.get(packageName);
  if (!resolvedVersions || resolvedVersions.size === 0) {
    return false;
  }
  return [...resolvedVersions].every((version) => override.unaffectedVersions.has(version));
}

export function filterFindingsBySeverity(advisoriesByPackage, minSeverity, versionsByPackage) {
  const threshold = normalizeAuditLevel(minSeverity);
  const findings = [];

  for (const [packageName, advisories] of Object.entries(advisoriesByPackage ?? {})) {
    if (!Array.isArray(advisories)) {
      continue;
    }
    for (const advisory of advisories) {
      if (!advisory || typeof advisory !== "object") {
        continue;
      }
      const severity = normalizeSeverity(advisory.severity);
      if ((SEVERITY_RANK[severity] ?? -1) < SEVERITY_RANK[threshold]) {
        continue;
      }
      if (shouldSuppressAdvisoryFinding({ packageName, advisory, versionsByPackage })) {
        continue;
      }
      findings.push({
        packageName,
        id: advisory.id ?? "unknown",
        severity,
        title: advisory.title ?? "Untitled advisory",
        url: advisory.url ?? null,
        vulnerableVersions: advisory.vulnerable_versions ?? null,
      });
    }
  }

  findings.sort((left, right) => {
    const severityDelta =
      (SEVERITY_RANK[right.severity] ?? -1) - (SEVERITY_RANK[left.severity] ?? -1);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.packageName.localeCompare(right.packageName);
  });

  return findings;
}

function chunkEntries(entries, size) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size));
  }
  return chunks;
}

function resolveRegistryBaseUrl() {
  const configured =
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    process.env.npm_config_userconfig_registry ??
    DEFAULT_REGISTRY;
  return configured.replace(/\/+$/u, "");
}

export async function fetchBulkAdvisories({
  payload,
  fetchImpl = fetch,
  registryBaseUrl = resolveRegistryBaseUrl(),
}) {
  const url = `${registryBaseUrl}${BULK_ADVISORY_PATH}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Bulk advisory request failed (${response.status} ${response.statusText}): ${bodyText}`,
    );
  }

  return response.json();
}

export async function runPnpmAuditProd({
  rootDir = process.cwd(),
  fetchImpl = fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  minSeverity = MIN_SEVERITY,
} = {}) {
  const normalizedMinSeverity = normalizeAuditLevel(minSeverity);
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");
  const lockfileText = await readFile(lockfilePath, "utf8");
  const versionsByPackage = collectProdResolvedPackagesFromLockfile(lockfileText);
  const payload = createBulkAdvisoryPayload(versionsByPackage);
  const payloadEntries = Object.entries(payload);

  if (payloadEntries.length === 0) {
    stdout.write("No production dependencies found in pnpm-lock.yaml.\n");
    return 0;
  }

  const advisoryResults = {};
  for (const payloadChunk of chunkEntries(payloadEntries, 400)) {
    const chunkPayload = Object.fromEntries(payloadChunk);
    const chunkResults = await fetchBulkAdvisories({
      payload: chunkPayload,
      fetchImpl,
    });
    Object.assign(advisoryResults, chunkResults);
  }

  const findings = filterFindingsBySeverity(
    advisoryResults,
    normalizedMinSeverity,
    versionsByPackage,
  );
  if (findings.length === 0) {
    stdout.write(
      `No ${normalizedMinSeverity} or higher advisories found for production dependencies.\n`,
    );
    return 0;
  }

  stderr.write(
    `Found ${findings.length} ${normalizedMinSeverity} or higher advisories in production dependencies:\n`,
  );
  for (const finding of findings.slice(0, 25)) {
    const details = [
      `${finding.severity.toUpperCase()} ${finding.packageName}`,
      `id=${finding.id}`,
      `title=${finding.title}`,
    ];
    if (finding.vulnerableVersions) {
      details.push(`range=${finding.vulnerableVersions}`);
    }
    if (finding.url) {
      details.push(`url=${finding.url}`);
    }
    stderr.write(`- ${details.join(" · ")}\n`);
  }
  if (findings.length > 25) {
    stderr.write(`...and ${findings.length - 25} more advisories.\n`);
  }
  return 1;
}

function parseArgs(argv) {
  let minSeverity = MIN_SEVERITY;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--audit-level" || argument === "--min-severity") {
      minSeverity = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument.startsWith("--audit-level=")) {
      minSeverity = argument.slice("--audit-level=".length);
      continue;
    }
    if (argument.startsWith("--min-severity=")) {
      minSeverity = argument.slice("--min-severity=".length);
      continue;
    }
    throw new Error(`Unknown argument "${argument}".`);
  }

  return { minSeverity };
}

async function main() {
  try {
    const { minSeverity } = parseArgs(process.argv.slice(2));
    process.exitCode = await runPnpmAuditProd({ minSeverity });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
