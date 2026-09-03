import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version.mjs";

function parseVersion(version) {
  return typeof version === "string"
    ? (parseReleaseVersion(version.trim()) ?? undefined)
    : undefined;
}

function compareOpenClawVersions(leftVersion, rightVersion) {
  const comparison = compareReleaseVersions(leftVersion, rightVersion);
  if (comparison === null) {
    throw new Error(`cannot compare OpenClaw versions: ${leftVersion} ${rightVersion}`);
  }
  return comparison;
}

function normalizeTargetContextRef(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.replace(/^refs\/heads\//u, "");
}

function isEarlierFinalSameExtendedStableLine(params) {
  const { baseline, candidate } = params;
  return (
    baseline?.channel === "stable" &&
    baseline.correctionNumber === undefined &&
    baseline.year === candidate.year &&
    baseline.month === candidate.month &&
    baseline.patch >= 33 &&
    compareOpenClawVersions(baseline.version, candidate.version) < 0
  );
}

export function resolveReleaseUpgradeBaseline(candidateVersion, publishedVersions, context = {}) {
  const targetContextRef = normalizeTargetContextRef(context.targetContextRef);
  const candidate = parseVersion(candidateVersion);
  if (!candidate) {
    throw new Error(`invalid candidate OpenClaw version: ${String(candidateVersion ?? "").trim()}`);
  }
  const allPublished = [
    ...new Set(
      publishedVersions
        .filter((version) => typeof version === "string")
        .map((version) => version.trim()),
    ),
  ].filter(Boolean);
  if (context.candidatePublished && !allPublished.includes(candidate.version)) {
    throw new Error(`published candidate ${candidate.version} is absent from npm versions`);
  }

  const published = allPublished
    .filter((version) => parseVersion(version)?.channel === "stable")
    .toSorted((left, right) => compareOpenClawVersions(right, left));
  const requestedBaseline = parseVersion(context.previousVersion);
  if (context.previousVersion !== undefined && !requestedBaseline) {
    throw new Error("previous_version must be a published stable predecessor");
  }

  if (!targetContextRef.startsWith("extended-stable/")) {
    const baseline =
      requestedBaseline?.version ??
      published.find((version) => compareOpenClawVersions(version, candidate.version) < 0);
    if (
      !baseline ||
      !published.includes(baseline) ||
      compareOpenClawVersions(baseline, candidate.version) >= 0
    ) {
      throw new Error(
        requestedBaseline
          ? `previous_version ${requestedBaseline.version} is not a published stable predecessor of ${candidate.version}`
          : `no published stable OpenClaw baseline predates candidate ${candidate.version}`,
      );
    }
    return `openclaw@${baseline}`;
  }

  // Frozen lines cannot upgrade from a newer release with a possibly incompatible SQLite schema.
  const line = /^extended-stable\/(?<year>\d{4})\.(?<month>[1-9]\d?)\.33$/u.exec(
    targetContextRef,
  )?.groups;
  if (!line) {
    throw new Error(`invalid frozen extended-stable context: ${targetContextRef}`);
  }

  if (
    candidate.channel !== "stable" ||
    candidate.correctionNumber !== undefined ||
    candidate.year !== Number(line.year) ||
    candidate.month !== Number(line.month) ||
    candidate.patch < 33
  ) {
    throw new Error(
      `candidate ${candidate.version} is incompatible with frozen extended-stable context ${targetContextRef}`,
    );
  }

  const baseline =
    requestedBaseline?.version ??
    published.find((version) =>
      isEarlierFinalSameExtendedStableLine({ baseline: parseVersion(version), candidate }),
    );
  if (
    !baseline ||
    !published.includes(baseline) ||
    !isEarlierFinalSameExtendedStableLine({ baseline: parseVersion(baseline), candidate })
  ) {
    throw new Error(
      requestedBaseline
        ? `previous_version ${requestedBaseline.version} is not a published final predecessor of ${candidate.version} on ${targetContextRef}`
        : `no published final extended-stable baseline predates candidate ${candidate.version} on ${targetContextRef}`,
    );
  }
  return `openclaw@${baseline}`;
}

export function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
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
  const raw = execFileSync(
    "npm",
    ["view", "openclaw", "versions", "--json", "--silent", "--prefer-online"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
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
  const publishedVersions = readPublishedVersions(args);
  const targetContextRef = args.get("target-context-ref");
  const previousVersion = args.get("previous-version");
  const baseline = resolveReleaseUpgradeBaseline(candidateVersion, publishedVersions, {
    candidatePublished: args.get("candidate-published") === "true",
    ...(previousVersion ? { previousVersion } : {}),
    ...(targetContextRef ? { targetContextRef } : {}),
  });
  process.stdout.write(`${baseline}\n`);
}
