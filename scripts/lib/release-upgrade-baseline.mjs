import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReleaseVersion } from "./release-version.mjs";

function parseVersion(version) {
  return parseReleaseVersion(String(version ?? "").trim()) ?? undefined;
}

export function compareOpenClawVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) {
    throw new Error(`cannot compare OpenClaw versions: ${leftVersion} ${rightVersion}`);
  }
  for (const key of ["year", "month", "patch"]) {
    const delta = left[key] - right[key];
    if (delta !== 0) {
      return delta;
    }
  }
  const channelRank = { alpha: 0, beta: 1, stable: 2 };
  const channelDelta = channelRank[left.channel] - channelRank[right.channel];
  if (channelDelta !== 0) {
    return channelDelta;
  }
  if (left.channel === "alpha") {
    return (left.alphaNumber ?? 0) - (right.alphaNumber ?? 0);
  }
  if (left.channel === "beta") {
    return (left.betaNumber ?? 0) - (right.betaNumber ?? 0);
  }
  return (left.correctionNumber ?? 0) - (right.correctionNumber ?? 0);
}

function normalizePublishedVersions(publishedVersions) {
  return [...new Set(publishedVersions.map((version) => String(version).trim()).filter(Boolean))]
    .filter((version) => parseVersion(version))
    .toSorted((left, right) => compareOpenClawVersions(right, left));
}

export function resolveDefaultReleaseUpgradeBaseline(candidateVersion, publishedVersions) {
  const candidate = parseVersion(candidateVersion);
  if (!candidate) {
    throw new Error(`invalid candidate OpenClaw version: ${candidateVersion}`);
  }

  const versions = normalizePublishedVersions(publishedVersions);
  const older = versions.find((version) => compareOpenClawVersions(version, candidate.version) < 0);
  if (older) {
    return `openclaw@${older}`;
  }

  const same = versions.find(
    (version) => compareOpenClawVersions(version, candidate.version) === 0,
  );
  if (same) {
    return `openclaw@${same}`;
  }

  throw new Error(`no published OpenClaw baseline is <= candidate ${candidate.version}`);
}

export function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
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

function readPublishedVersions(args) {
  const versionsJson = args.get("versions-json");
  if (versionsJson) {
    const parsed = JSON.parse(readFileSync(versionsJson, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error(`npm versions list must be a JSON array: ${versionsJson}`);
    }
    return parsed;
  }
  const raw = execFileSync("npm", ["view", "openclaw", "versions", "--json", "--silent"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("npm returned a non-array openclaw versions payload");
  }
  return parsed;
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const candidateVersion = args.get("candidate-version");
  if (!candidateVersion) {
    throw new Error("--candidate-version is required");
  }
  const baseline = resolveDefaultReleaseUpgradeBaseline(
    candidateVersion,
    readPublishedVersions(args),
  );
  process.stdout.write(`${baseline}\n`);
}
