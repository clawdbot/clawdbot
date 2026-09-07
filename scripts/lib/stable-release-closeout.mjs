import { createHash } from "node:crypto";
import { escapeRegExp } from "./regexp.mjs";

const STABLE_RELEASE_TAG_RE = /^v(?<version>\d{4}\.\d{1,2}\.\d{1,2})(?:-[1-9]\d*)?$/u;
const STABLE_PACKAGE_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>\d{1,2})\.(?<patch>\d{1,2})(?:-(?<correction>[1-9]\d*))?$/u;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;
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

function isSha256Hex(value) {
  return typeof value === "string" && value.length === 64 && SHA256_HEX_RE.test(value);
}

function isCanonicalAssetDigest(value) {
  return (
    typeof value === "string" &&
    value.length === 71 &&
    value.startsWith("sha256:") &&
    isSha256Hex(value.slice(7))
  );
}

function readVerifiedAssetNames(assets) {
  return new Set(
    assets.filter((asset) => isCanonicalAssetDigest(asset.digest)).map((asset) => asset.name),
  );
}

function copyOwnFields(source, ...keys) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
}

function recordsEqual(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const expectedEntries = Object.entries(expected);
  return (
    Object.keys(actual).length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => actual[key] === value)
  );
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
  const platformAssets = {
    macos: expectedMacAssets,
    android: ["OpenClaw-Android-SHA256SUMS.txt", "OpenClaw-Android.apk"],
    windows: [
      "OpenClawCompanion-SHA256SUMS.txt",
      "OpenClawCompanion-Setup-arm64.exe",
      "OpenClawCompanion-Setup-x64.exe",
    ],
  };
  const expectedAppAssets = new Set(Object.values(platformAssets).flat());
  const observedAssets = readReleaseAssets(params.release).filter(
    (asset) => !isCloseoutEvidenceAsset(asset.name, params.tag),
  );
  const existingManifest = params.existingManifest;
  const releaseAssets =
    existingManifest?.githubReleaseAssets ??
    observedAssets.map((asset) => ({
      name: asset.name,
      digest: typeof asset.digest === "string" ? asset.digest : null,
    }));
  if (existingManifest) {
    // Closeout records a publication-time snapshot. Later app attachments may
    // extend it, but must never rewrite recorded assets or release evidence.
    for (const recorded of releaseAssets) {
      const observed = observedAssets.find((asset) => asset.name === recorded.name);
      const observedDigest =
        observed && typeof observed.digest === "string" ? observed.digest : null;
      if (!observed || observedDigest !== recorded.digest) {
        errors.push(`Recorded release asset changed or disappeared: ${recorded.name}.`);
      }
    }
    for (const observed of observedAssets) {
      if (
        !releaseAssets.some((asset) => asset.name === observed.name) &&
        !expectedAppAssets.has(observed.name)
      ) {
        errors.push(`Unexpected release asset added after closeout: ${observed.name}.`);
      }
    }
  }
  const verifiedAssetNames = readVerifiedAssetNames(releaseAssets);
  const verifiedObservedAssetNames = readVerifiedAssetNames(observedAssets);
  const macAttachedAtCloseout = expectedMacAssets.every((asset) => verifiedAssetNames.has(asset));
  const macPublished = expectedMacAssets.every((name) => verifiedObservedAssetNames.has(name));
  const appcastVerifiedAtCloseout = existingManifest
    ? existingManifest.appcast === "verified" ||
      (!Object.hasOwn(existingManifest, "appcast") &&
        Object.hasOwn(existingManifest, "appcastSha256"))
    : macAttachedAtCloseout;
  // A verified recorded appcast remains bound to its original main snapshot.
  // Fresh closeout and late macOS publication still verify the current feed.
  const appcast = params.publishedAppcast ?? params.mainAppcast;
  if (
    macPublished &&
    (!existingManifest || !appcastVerifiedAtCloseout) &&
    !appcast.includes(`/releases/download/${params.tag}/${expectedMacAssets[0]}`)
  ) {
    errors.push(`main appcast.xml does not point at ${expectedMacAssets[0]} from ${params.tag}.`);
  }
  const appPlatforms = Object.fromEntries(
    Object.entries(platformAssets).map(([platform, assets]) => [
      platform,
      assets.every((asset) => verifiedAssetNames.has(asset)) ? "attached" : "pending",
    ]),
  );
  const apps = Object.values(appPlatforms).every((state) => state === "attached")
    ? "attached"
    : "pending";
  if (existingManifest) {
    if (
      Object.hasOwn(existingManifest, "appPlatforms") &&
      !recordsEqual(existingManifest.appPlatforms, appPlatforms)
    ) {
      errors.push("Recorded app platform states do not match canonical release asset digests.");
    }
    if (Object.hasOwn(existingManifest, "apps") && existingManifest.apps !== apps) {
      errors.push("Recorded aggregate app state does not match canonical release asset digests.");
    }
    const expectedAppcastState = macAttachedAtCloseout ? "verified" : "pending";
    if (
      Object.hasOwn(existingManifest, "appcast") &&
      existingManifest.appcast !== expectedAppcastState
    ) {
      errors.push("Recorded appcast state does not match canonical macOS release asset digests.");
    }
    const hasAppcastSha256 = Object.hasOwn(existingManifest, "appcastSha256");
    if (
      hasAppcastSha256 !== macAttachedAtCloseout ||
      (hasAppcastSha256 && !isSha256Hex(existingManifest.appcastSha256))
    ) {
      errors.push(
        "Recorded appcast hash presence or format does not match canonical macOS release asset state.",
      );
    }
  }

  verifyRollbackDrill(params, errors);

  if (errors.length > 0) {
    return { errors, manifest: null };
  }

  const manifest = {
    version: 2,
    releaseTag: params.tag,
    releaseVersion: version,
    releaseTagSha: params.releaseTagSha,
    mainSha: params.mainSha,
    mainPackageVersion: mainVersion,
    releaseTagPackageVersion: tagPackageVersion,
    changelogSha256: sha256(mainChangelog),
    ...(existingManifest
      ? copyOwnFields(existingManifest, "apps", "appPlatforms", "appcast", "appcastSha256")
      : {
          apps,
          appPlatforms,
          appcast: macAttachedAtCloseout ? "verified" : "pending",
          ...(macAttachedAtCloseout ? { appcastSha256: sha256(params.mainAppcast) } : {}),
        }),
    fullReleaseValidationRunId: params.fullReleaseValidationRunId,
    fullReleaseValidationRunAttempt,
    releasePublishRunId: params.releasePublishRunId,
    ...(existingManifest
      ? copyOwnFields(existingManifest, "releasePublishRecovery")
      : params.allowFailedPublishRecovery
        ? { releasePublishRecovery: { npmDockerVerified: true } }
        : {}),
    rollbackDrill: {
      id: params.rollbackDrillId,
      date: params.rollbackDrillDate,
    },
    githubReleaseAssets: releaseAssets,
  };
  if (existingManifest && JSON.stringify(manifest) !== JSON.stringify(existingManifest)) {
    return {
      errors: ["Recorded closeout manifest does not match the verified release state."],
      manifest: null,
    };
  }
  return { errors, manifest };
}
