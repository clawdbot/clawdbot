import { createHash } from "node:crypto";
import { escapeRegExp } from "./regexp.mjs";

const STABLE_RELEASE_TAG_RE = /^v(?<version>\d{4}\.\d{1,2}\.\d{1,2})(?:-[1-9]\d*)?$/u;
const STABLE_PACKAGE_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>\d{1,2})\.(?<patch>\d{1,2})(?:-(?<correction>[1-9]\d*))?$/u;
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

function parseStablePackageVersion(version) {
  const match = STABLE_PACKAGE_VERSION_RE.exec(version);
  if (!match?.groups) {
    return null;
  }
  return [
    Number.parseInt(match.groups.year, 10),
    Number.parseInt(match.groups.month, 10),
    Number.parseInt(match.groups.patch, 10),
    Number.parseInt(match.groups.correction ?? "0", 10),
  ];
}

function isStableMainVersionAtLeast(mainVersion, shippedVersion) {
  const main = parseStablePackageVersion(mainVersion);
  const shipped = parseStablePackageVersion(shippedVersion);
  if (!main || !shipped) {
    return false;
  }
  for (let index = 0; index < main.length; index += 1) {
    if (main[index] !== shipped[index]) {
      return main[index] > shipped[index];
    }
  }
  return true;
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
  const fallbackCorrection = tagVersion !== baseVersion && tagPackageVersion === baseVersion;
  const version = fallbackCorrection ? baseVersion : tagVersion;

  const fullReleaseValidationRunAttempt = params.fullReleaseValidationRunAttempt ?? "";
  if (!/^[1-9]\d*$/u.test(fullReleaseValidationRunAttempt)) {
    errors.push(
      `full release validation run attempt is invalid: ${fullReleaseValidationRunAttempt || "<missing>"}.`,
    );
  }

  if (mainVersion && !isStableMainVersionAtLeast(mainVersion, version)) {
    errors.push(
      `main package.json version is ${mainVersion}, expected shipped version ${version} or a later stable OpenClaw CalVer.`,
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
  const releaseAssets = readReleaseAssets(params.release);
  const assetNames = new Set(releaseAssets.map((asset) => asset.name));
  let releasePublishRecovery = null;
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

  if (params.requireCompletePlatformAssets) {
    const requiredPlatformFamilies = [
      {
        label: "Android",
        prefix: "OpenClaw-Android",
        expected: ["OpenClaw-Android-SHA256SUMS.txt", "OpenClaw-Android.apk"],
      },
      {
        label: "Windows",
        prefix: "OpenClawCompanion-",
        expected: [
          "OpenClawCompanion-SHA256SUMS.txt",
          "OpenClawCompanion-Setup-arm64.exe",
          "OpenClawCompanion-Setup-x64.exe",
        ],
      },
    ];
    for (const family of requiredPlatformFamilies) {
      const compareNames = (left, right) => left.localeCompare(right);
      const actual = [...assetNames]
        .filter((name) => name.startsWith(family.prefix))
        .toSorted(compareNames);
      const expected = family.expected.toSorted(compareNames);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        errors.push(
          `GitHub release ${params.tag} ${family.label} asset names do not match the recovery contract: expected ${family.expected.join(", ")}; got ${actual.join(", ") || "<none>"}.`,
        );
      }
      const invalidDigests = family.expected.filter((name) => {
        const asset = releaseAssets.find((candidate) => candidate.name === name);
        return !/^sha256:[0-9a-f]{64}$/u.test(asset?.digest ?? "");
      });
      if (invalidDigests.length > 0) {
        errors.push(
          `GitHub release ${params.tag} ${family.label} recovery asset(s) lack GitHub SHA-256 digests: ${invalidDigests.join(", ")}.`,
        );
      }
    }

    const windowsInstallerNames = [
      "OpenClawCompanion-Setup-arm64.exe",
      "OpenClawCompanion-Setup-x64.exe",
    ];
    let trustedWindowsDigests = params.windowsNodeInstallerDigests;
    if (typeof trustedWindowsDigests === "string") {
      try {
        trustedWindowsDigests = JSON.parse(trustedWindowsDigests);
      } catch {
        trustedWindowsDigests = null;
      }
    }
    const trustedDigestNames =
      trustedWindowsDigests &&
      typeof trustedWindowsDigests === "object" &&
      !Array.isArray(trustedWindowsDigests)
        ? Object.keys(trustedWindowsDigests).toSorted((left, right) => left.localeCompare(right))
        : [];
    const expectedDigestNames = windowsInstallerNames.toSorted((left, right) =>
      left.localeCompare(right),
    );
    const trustedDigestContractValid =
      JSON.stringify(trustedDigestNames) === JSON.stringify(expectedDigestNames) &&
      windowsInstallerNames.every((name) =>
        /^sha256:[0-9a-f]{64}$/u.test(trustedWindowsDigests?.[name] ?? ""),
      );
    if (!trustedDigestContractValid) {
      errors.push(
        "failed-publish recovery is missing the exact candidate-approved Windows installer digests.",
      );
    } else {
      const mismatchedWindowsAssets = windowsInstallerNames.filter((name) => {
        const asset = releaseAssets.find((candidate) => candidate.name === name);
        return asset?.digest !== trustedWindowsDigests[name];
      });
      if (mismatchedWindowsAssets.length > 0) {
        errors.push(
          `GitHub release ${params.tag} Windows recovery asset(s) do not match candidate-approved digests: ${mismatchedWindowsAssets.join(", ")}.`,
        );
      }
    }
    if (!/^[1-9]\d*$/u.test(params.windowsNodeReleaseRunId ?? "")) {
      errors.push("failed-publish recovery is missing a trusted Windows Node Release run id.");
    }
    if (trustedDigestContractValid && /^[1-9]\d*$/u.test(params.windowsNodeReleaseRunId ?? "")) {
      releasePublishRecovery = {
        completePlatformAssetsRequired: true,
        windowsNodeReleaseRunId: params.windowsNodeReleaseRunId,
        windowsNodeInstallerDigests: Object.fromEntries(
          windowsInstallerNames.map((name) => [name, trustedWindowsDigests[name]]),
        ),
      };
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
      ...(releasePublishRecovery ? { releasePublishRecovery } : {}),
      rollbackDrill: {
        id: params.rollbackDrillId,
        date: params.rollbackDrillDate,
      },
      githubReleaseAssets: releaseAssets
        .filter((asset) => !isCloseoutEvidenceAsset(asset.name, params.tag))
        .map((asset) => ({
          name: asset.name,
          digest: typeof asset.digest === "string" ? asset.digest : null,
        })),
    },
  };
}
