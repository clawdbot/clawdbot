import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version.mjs";

function parseVersion(version: unknown) {
  return parseReleaseVersion(normalizeStringifiedOptionalString(version) ?? "") ?? undefined;
}

function compareOpenClawVersions(leftVersion: string, rightVersion: string) {
  const comparison = compareReleaseVersions(leftVersion, rightVersion);
  if (comparison === null) {
    throw new Error(`cannot compare OpenClaw versions: ${leftVersion} ${rightVersion}`);
  }
  return comparison;
}

function normalizePublishedVersions(publishedVersions: readonly unknown[]) {
  return [
    ...new Set(
      publishedVersions
        .map((version) => normalizeStringifiedOptionalString(version))
        .filter((version): version is string => version !== undefined),
    ),
  ]
    .filter((version) => parseVersion(version)?.channel === "stable")
    .toSorted((left, right) => compareOpenClawVersions(right, left));
}

type FrozenExtendedStableUpgradeContext = {
  previousVersion?: unknown;
  targetContextRef: unknown;
};

function normalizeTargetContextRef(value: unknown) {
  const raw = normalizeStringifiedOptionalString(value) ?? "";
  return raw.replace(/^refs\/heads\//u, "");
}

function isEarlierFinalSameExtendedStableLine(params: {
  baseline: ReturnType<typeof parseVersion>;
  candidate: NonNullable<ReturnType<typeof parseVersion>>;
}) {
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

/**
 * Frozen extended-stable validation must upgrade from an earlier release in
 * the same line. A current latest install can have a newer SQLite schema.
 */
export function resolveFrozenExtendedStableUpgradeBaseline(
  candidateVersion: unknown,
  publishedVersions: readonly unknown[],
  context: FrozenExtendedStableUpgradeContext,
) {
  const targetContextRef = normalizeTargetContextRef(context.targetContextRef);
  if (!targetContextRef.startsWith("extended-stable/")) {
    return undefined;
  }

  const line = /^extended-stable\/(?<year>\d{4})\.(?<month>[1-9]\d?)\.33$/u.exec(
    targetContextRef,
  )?.groups;
  if (!line) {
    throw new Error(`invalid frozen extended-stable context: ${targetContextRef}`);
  }

  const candidate = parseVersion(candidateVersion);
  if (
    !candidate ||
    candidate.channel !== "stable" ||
    candidate.correctionNumber !== undefined ||
    candidate.year !== Number(line.year) ||
    candidate.month !== Number(line.month) ||
    candidate.patch < 33
  ) {
    throw new Error(
      `candidate ${normalizeStringifiedOptionalString(candidateVersion) ?? ""} is incompatible with frozen extended-stable context ${targetContextRef}`,
    );
  }

  const published = normalizePublishedVersions(publishedVersions);
  const requestedBaseline = parseVersion(
    normalizeStringifiedOptionalString(context.previousVersion) ?? "",
  );
  if (context.previousVersion !== undefined && !requestedBaseline) {
    throw new Error("previous_version must be a final published extended-stable predecessor");
  }
  if (requestedBaseline) {
    if (
      !isEarlierFinalSameExtendedStableLine({ baseline: requestedBaseline, candidate }) ||
      !published.includes(requestedBaseline.version)
    ) {
      throw new Error(
        `previous_version ${requestedBaseline.version} is not a published final predecessor of ${candidate.version} on ${targetContextRef}`,
      );
    }
    return `openclaw@${requestedBaseline.version}`;
  }

  const baseline = published.find((version) =>
    isEarlierFinalSameExtendedStableLine({ baseline: parseVersion(version), candidate }),
  );
  if (!baseline) {
    throw new Error(
      `no published final extended-stable baseline predates candidate ${candidate.version} on ${targetContextRef}`,
    );
  }
  return `openclaw@${baseline}`;
}

export function resolveDefaultReleaseUpgradeBaseline(
  candidateVersion: unknown,
  publishedVersions: readonly unknown[],
) {
  const candidate = parseVersion(candidateVersion);
  if (!candidate) {
    const candidateText = normalizeStringifiedOptionalString(candidateVersion) ?? "";
    throw new Error(`invalid candidate OpenClaw version: ${candidateText}`);
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

  throw new Error(`no published stable OpenClaw baseline is <= candidate ${candidate.version}`);
}

export function parseArgs(argv: readonly string[]) {
  const args = new Map<string, string>();
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

function readPublishedVersions(args: Map<string, string>): unknown[] {
  const versionsJson = args.get("versions-json");
  if (versionsJson) {
    const parsed: unknown = JSON.parse(readFileSync(versionsJson, "utf8"));
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
  const parsed: unknown = JSON.parse(raw);
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
  const baseline = targetContextRef
    ? resolveFrozenExtendedStableUpgradeBaseline(candidateVersion, publishedVersions, {
        ...(previousVersion ? { previousVersion } : {}),
        targetContextRef,
      })
    : resolveDefaultReleaseUpgradeBaseline(candidateVersion, publishedVersions);
  if (!baseline) {
    throw new Error("target-context-ref does not identify a frozen extended-stable release");
  }
  process.stdout.write(`${baseline}\n`);
}
