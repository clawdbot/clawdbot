// Resolves Docker upgrade-survivor baseline specs from requested tokens and
// live release history JSON captured by release workflows.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeUpgradeSurvivorBaselineSpec } from "./lib/docker-e2e-plan.mts";
import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "./lib/release-version.mjs";

type ReleaseRecord = Partial<Record<"isPrerelease" | "publishedAt" | "tagName", unknown>>;

function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`missing value for --${key}`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function splitSpecs(raw: unknown) {
  return scalarText(raw)
    .split(/[,\s]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function dedupeSpecs(specs: string[]) {
  const normalized = specs
    .map(normalizeUpgradeSurvivorBaselineSpec)
    .filter((spec) => spec !== undefined);
  return [...new Set(normalized)];
}

function parsePositiveInteger(value: unknown, label: string) {
  const text = scalarText(value).trim();
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readPublishedVersions(file: string | undefined) {
  if (!file) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`npm versions list must be a JSON array: ${file}`);
  }
  return new Set(parsed.filter((version) => typeof version === "string"));
}

function stableVersionFromTag(tagName: unknown) {
  const version = typeof tagName === "string" ? tagName.replace(/^v/u, "") : "";
  return parseStableVersion(version) ? version : undefined;
}

function parseStableVersion(version: unknown) {
  const parsed = parseReleaseVersion(typeof version === "string" ? version : "");
  return parsed && classifyReleaseTrain(parsed) === "stable" ? parsed : undefined;
}

function compareStableVersions(left: string, right: string) {
  if (!parseStableVersion(left) || !parseStableVersion(right)) {
    throw new Error(`cannot compare release versions: ${left} ${right}`);
  }
  const comparison = compareReleaseVersions(left, right);
  if (comparison === null) {
    throw new Error(`cannot compare release versions: ${left} ${right}`);
  }
  return comparison;
}

function npmPublishedVersion(version: string | undefined, publishedVersions?: Set<string>) {
  if (!version || !publishedVersions) {
    return version;
  }
  if (publishedVersions.has(version)) {
    return version;
  }
  const baseVersion = version.replace(/-[0-9]+$/u, "");
  return publishedVersions.has(baseVersion) ? baseVersion : undefined;
}

function isReleaseRecord(value: unknown): value is ReleaseRecord {
  return typeof value === "object" && value !== null;
}

function readStableReleases(file: string, publishedVersions?: Set<string>) {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const raw = readFileSync(file, "utf8").replace(ansiEscape, "");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`release list must be a JSON array: ${file}`);
  }
  return parsed
    .filter(isReleaseRecord)
    .filter((release) => !release.isPrerelease)
    .flatMap((release) => {
      const publishedAt = typeof release.publishedAt === "string" ? release.publishedAt : undefined;
      const version = npmPublishedVersion(stableVersionFromTag(release.tagName), publishedVersions);
      return publishedAt && version ? [{ publishedAt, version }] : [];
    })
    .toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/**
 * Expands the release-history token into recent stable plus pinned historical baselines.
 */
function resolveReleaseHistory(args: Map<string, string>) {
  const releasesJson = args.get("releases-json");
  if (!releasesJson) {
    throw new Error("--releases-json is required when requested baselines include release-history");
  }
  const historyCount = parsePositiveInteger(args.get("history-count") ?? "6", "--history-count");
  const includeVersion = args.get("include-version") ?? "2026.4.23";
  const preDate = args.get("pre-date") ?? "2026-03-15T00:00:00Z";
  const publishedVersions = readPublishedVersions(args.get("npm-versions-json"));
  const releases = readStableReleases(releasesJson, publishedVersions);
  const versions = releases.slice(0, historyCount).map((release) => release.version);
  const exact = releases.find((release) => release.version === includeVersion);
  if (exact) {
    versions.push(exact.version);
  }
  const preDateRelease = releases.find(
    (release) => new Date(release.publishedAt).getTime() < new Date(preDate).getTime(),
  );
  if (preDateRelease) {
    versions.push(preDateRelease.version);
  }
  return dedupeSpecs(versions);
}

/**
 * Resolves the last N stable release versions from release metadata.
 */
function resolveLastStable(args: Map<string, string>, count: number) {
  const releasesJson = args.get("releases-json");
  if (!releasesJson) {
    throw new Error("--releases-json is required when requested baselines include last-stable-*");
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`invalid last-stable baseline count: ${count}`);
  }
  const publishedVersions = readPublishedVersions(args.get("npm-versions-json"));
  const releases = readStableReleases(releasesJson, publishedVersions);
  return dedupeSpecs(releases.slice(0, count).map((release) => release.version));
}

/**
 * Resolves all stable release versions at or after the requested minimum.
 */
function resolveAllSince(args: Map<string, string>, minimumVersion: string) {
  const releasesJson = args.get("releases-json");
  if (!releasesJson) {
    throw new Error("--releases-json is required when requested baselines include all-since-*");
  }
  const publishedVersions = readPublishedVersions(args.get("npm-versions-json"));
  const releases = readStableReleases(releasesJson, publishedVersions);
  return dedupeSpecs(
    releases
      .map((release) => release.version)
      .filter((version) => compareStableVersions(version, minimumVersion) >= 0),
  );
}

/**
 * Expands requested baseline tokens into normalized package/version specs.
 */
export function resolveBaselines(args: Map<string, string>) {
  const requested = args.get("requested") ?? "";
  const fallback = args.get("fallback") ?? "openclaw@latest";
  const requestedTokens = splitSpecs(requested);
  if (requestedTokens.length === 0) {
    return dedupeSpecs([fallback]);
  }
  const resolved: string[] = [];
  for (const token of requestedTokens) {
    if (token === "release-history") {
      resolved.push(...resolveReleaseHistory(args));
    } else if (token.startsWith("last-stable-")) {
      const count = parsePositiveInteger(
        token.slice("last-stable-".length),
        "last-stable baseline count",
      );
      resolved.push(...resolveLastStable(args, count));
    } else if (token.startsWith("all-since-")) {
      const minimumVersion = token.slice("all-since-".length);
      if (!parseStableVersion(minimumVersion)) {
        throw new Error(`invalid all-since baseline token: ${token}`);
      }
      resolved.push(...resolveAllSince(args, minimumVersion));
    } else {
      resolved.push(token);
    }
  }
  return dedupeSpecs(resolved);
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const baselines = resolveBaselines(args).join(" ");
  process.stdout.write(`${baselines}\n`);

  const githubOutput = args.get("github-output");
  if (githubOutput) {
    writeFileSync(githubOutput, `baselines=${baselines}\n`, { flag: "a" });
  }
}
