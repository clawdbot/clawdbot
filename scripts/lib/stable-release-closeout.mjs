import { createHash } from "node:crypto";
import { escapeRegExp } from "./regexp.mjs";

const STABLE_RELEASE_TAG_RE = /^v(?<version>\d{4}\.\d{1,2}\.\d{1,2})(?:-[1-9]\d*)?$/u;
const MAX_ROLLBACK_DRILL_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function parseStableReleaseTagDetails(tag) {
  const match = STABLE_RELEASE_TAG_RE.exec(tag);
  if (!match?.groups?.version) {
    throw new Error(`expected a stable release tag, got ${tag}`);
  }
  return {
    baseVersion: match.groups.version,
    tagVersion: tag.slice(1),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseStableReleaseTag(tag) {
  return parseStableReleaseTagDetails(tag).baseVersion;
}

export function extractStableChangelogSection(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\n`, "mu").exec(changelog);
  if (!heading || heading.index === undefined) {
    return null;
  }

  const section = changelog.slice(heading.index);
  const nextHeading = section.slice(heading[0].length).search(/^## /mu);
  return (
    nextHeading === -1 ? section : section.slice(0, heading[0].length + nextHeading)
  ).trimEnd();
}

function readVersion(packageJson, label, errors) {
  const value = packageJson?.version;
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} package.json is missing a version.`);
    return "";
  }
  return value;
}

function readReleaseAssets(release) {
  return Array.isArray(release?.assets)
    ? release.assets.filter((asset) => asset && typeof asset.name === "string")
    : [];
}

function isCloseoutEvidenceAsset(assetName, tag) {
  const releaseVersion = tag.slice(1);
  return (
    assetName === `openclaw-${releaseVersion}-stable-main-closeout.json` ||
    assetName === `openclaw-${releaseVersion}-stable-main-closeout.json.sha256`
  );
}

function parseRollbackDrillDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed.getTime()
    : null;
}

function verifyRollbackDrill(params, errors) {
  if (!params.rollbackDrillId?.trim()) {
    errors.push("rollback drill id is required.");
  }

  const drillDateMs = parseRollbackDrillDate(params.rollbackDrillDate);
  if (drillDateMs === null) {
    errors.push(`rollback drill date is invalid: ${params.rollbackDrillDate ?? "<missing>"}.`);
    return;
  }

  const ageMs = params.nowMs - drillDateMs;
  if (ageMs < 0) {
    errors.push(`rollback drill date is in the future: ${params.rollbackDrillDate}.`);
  } else if (!params.allowStaleRollbackDrill && ageMs > MAX_ROLLBACK_DRILL_AGE_MS) {
    errors.push(
      `rollback drill is older than 90 days: ${params.rollbackDrillDate}. Run the private rollback drill before stable closeout.`,
    );
  }
}

export function verifyStableMainCloseout(params) {
  const { baseVersion, tagVersion } = parseStableReleaseTagDetails(params.tag);
  const errors = [];
  const mainVersion = readVersion(params.mainPackageJson, "main", errors);
  const tagPackageVersion = readVersion(params.tagPackageJson, "release tag", errors);
  const fallbackCorrection =
    tagVersion !== baseVersion && mainVersion === baseVersion && tagPackageVersion === baseVersion;
  const version = fallbackCorrection ? baseVersion : tagVersion;

  const fullReleaseValidationRunAttempt = params.fullReleaseValidationRunAttempt ?? "";
  if (!/^[1-9]\d*$/u.test(fullReleaseValidationRunAttempt)) {
    errors.push(
      `full release validation run attempt is invalid: ${fullReleaseValidationRunAttempt || "<missing>"}.`,
    );
  }

  if (mainVersion && mainVersion !== version) {
    errors.push(
      `main package.json version is ${mainVersion}, expected shipped version ${version}.`,
    );
  }
  if (tagPackageVersion && tagPackageVersion !== version) {
    errors.push(
      `release tag package.json version is ${tagPackageVersion}, expected shipped version ${version}.`,
    );
  }

  const mainChangelog = extractStableChangelogSection(params.mainChangelog, version);
  const tagChangelog = extractStableChangelogSection(params.tagChangelog, version);
  if (!mainChangelog) {
    errors.push(`main CHANGELOG.md is missing the ## ${version} section.`);
  }
  if (!tagChangelog) {
    errors.push(`release tag CHANGELOG.md is missing the ## ${version} section.`);
  }
  if (mainChangelog && tagChangelog && mainChangelog !== tagChangelog) {
    errors.push(
      `main CHANGELOG.md ## ${version} does not exactly match the shipped release section.`,
    );
  }

  if (params.release?.tagName !== params.tag) {
    errors.push(
      `GitHub release tag is ${String(params.release?.tagName ?? "<missing>")}, expected ${params.tag}.`,
    );
  }
  if (params.release?.isDraft === true) {
    errors.push(`GitHub release ${params.tag} is still a draft.`);
  }
  if (params.release?.isPrerelease === true) {
    errors.push(`GitHub release ${params.tag} is marked as a prerelease.`);
  }

  const macAssetVersion = version;
  const expectedMacAssets = [
    `OpenClaw-${macAssetVersion}.zip`,
    `OpenClaw-${macAssetVersion}.dmg`,
    `OpenClaw-${macAssetVersion}.dSYM.zip`,
  ];
  const assetNames = new Set(readReleaseAssets(params.release).map((asset) => asset.name));
  const missingMacAssets = expectedMacAssets.filter((asset) => !assetNames.has(asset));
  if (missingMacAssets.length > 0) {
    errors.push(
      `GitHub release ${params.tag} is missing required macOS asset(s): ${missingMacAssets.join(", ")}.`,
    );
  } else {
    const macZip = expectedMacAssets[0];
    if (!params.mainAppcast.includes(`/releases/download/${params.tag}/${macZip}`)) {
      errors.push(`main appcast.xml does not point at ${macZip} from ${params.tag}.`);
    }
  }

  verifyRollbackDrill(params, errors);

  if (errors.length > 0) {
    return { errors, manifest: null };
  }

  return {
    errors,
    manifest: {
      version: 2,
      releaseTag: params.tag,
      releaseVersion: version,
      releaseTagSha: params.releaseTagSha,
      mainSha: params.mainSha,
      mainPackageVersion: mainVersion,
      releaseTagPackageVersion: tagPackageVersion,
      changelogSha256: sha256(mainChangelog),
      appcastSha256: sha256(params.mainAppcast),
      fullReleaseValidationRunId: params.fullReleaseValidationRunId,
      fullReleaseValidationRunAttempt,
      releasePublishRunId: params.releasePublishRunId,
      rollbackDrill: {
        id: params.rollbackDrillId,
        date: params.rollbackDrillDate,
      },
      githubReleaseAssets: readReleaseAssets(params.release)
        .filter((asset) => !isCloseoutEvidenceAsset(asset.name, params.tag))
        .map((asset) => ({
          name: asset.name,
          digest: typeof asset.digest === "string" ? asset.digest : null,
        })),
    },
  };
}
