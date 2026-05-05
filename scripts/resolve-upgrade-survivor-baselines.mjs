import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeUpgradeSurvivorBaselineSpec } from "./lib/docker-e2e-plan.mjs";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function splitSpecs(raw) {
  return String(raw ?? "")
    .split(/[,\s]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function dedupeSpecs(specs) {
  return [...new Set(specs.map(normalizeUpgradeSurvivorBaselineSpec).filter(Boolean))];
}

function readPublishedVersions(file) {
  if (!file) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`npm versions list must be a JSON array: ${file}`);
  }
  return new Set(parsed.filter((version) => typeof version === "string"));
}

function stableVersionFromTag(tagName) {
  const version = String(tagName ?? "").replace(/^v/u, "");
  if (!/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?$/u.test(version)) {
    return undefined;
  }
  return version;
}

function parseStableVersion(version) {
  const match = /^([0-9]{4})\.([0-9]+)\.([0-9]+)(?:-([0-9]+))?$/u.exec(String(version ?? ""));
  if (!match) {
    return undefined;
  }
  return match.slice(1).map((part) => Number.parseInt(part ?? "0", 10));
}

function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) {
    throw new Error(`cannot compare release versions: ${left} ${right}`);
  }
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function npmPublishedVersion(version, publishedVersions) {
  if (!version || !publishedVersions) {
    return version;
  }
  if (publishedVersions.has(version)) {
    return version;
  }
  const baseVersion = version.replace(/-[0-9]+$/u, "");
  return publishedVersions.has(baseVersion) ? baseVersion : undefined;
}

function readStableReleases(file, publishedVersions) {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const raw = readFileSync(file, "utf8").replace(ansiEscape, "");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`release list must be a JSON array: ${file}`);
  }
  return parsed
    .filter((release) => !release.isPrerelease)
    .map((release) => ({
      publishedAt: release.publishedAt,
      version: npmPublishedVersion(stableVersionFromTag(release.tagName), publishedVersions),
    }))
    .filter((release) => release.version && release.publishedAt)
    .toSorted((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

export function resolveReleaseHistory(args) {
  const releasesJson = args.get("releases-json");
  if (!releasesJson) {
    throw new Error("--releases-json is required when requested baselines include release-history");
  }
  const historyCount = Number.parseInt(args.get("history-count") ?? "6", 10);
  if (!Number.isInteger(historyCount) || historyCount < 1) {
    throw new Error("--history-count must be a positive integer");
  }
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

export function resolveLastStable(args, count) {
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

export function resolveAllSince(args, minimumVersion) {
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

export function resolveBaselines(args) {
  const requested = args.get("requested") ?? "";
  const fallback = args.get("fallback") ?? "openclaw@latest";
  const requestedTokens = splitSpecs(requested);
  if (requestedTokens.length === 0) {
    return dedupeSpecs([fallback]);
  }
  const resolved = [];
  for (const token of requestedTokens) {
    if (token === "release-history") {
      resolved.push(...resolveReleaseHistory(args));
    } else if (token.startsWith("last-stable-")) {
      const count = Number.parseInt(token.slice("last-stable-".length), 10);
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
