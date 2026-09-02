// iOS release planning keeps App Store version and build selection deterministic.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  encodeIosAppStoreVersion,
  extractChangelogSection,
  MAX_IOS_APP_STORE_REVISION,
  normalizeIosAppStoreRevision,
  normalizePinnedIosVersion,
} from "./ios-version.ts";

const IOS_BUILD_UPLOAD_STATES = ["AWAITING_UPLOAD", "PROCESSING", "FAILED", "COMPLETE"] as const;
// 2026.7.2 is the last exact-version iOS release in App Store Connect.
// Later exact CalVer values must not be confused with appended revision versions.
const LAST_LEGACY_IOS_APP_STORE_VERSION = "2026.7.2";

const EDITABLE_APP_STORE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
  "READY_FOR_REVIEW",
]);

const RELEASED_APP_STORE_VERSION_STATES = new Set([
  "READY_FOR_DISTRIBUTION",
  "REPLACED_WITH_NEW_VERSION",
  "READY_FOR_SALE",
  "REMOVED_FROM_SALE",
  "DEVELOPER_REMOVED_FROM_SALE",
]);

type IosRemoteAppStoreVersion = {
  id: string;
  state: string;
  versionString: string;
};

type IosRemoteBuildUpload = {
  buildNumber: string;
  shortVersion: string;
  state: string;
};

export type IosReleasePlanInput = {
  appStoreVersions: IosRemoteAppStoreVersion[];
  buildUploads: IosRemoteBuildUpload[];
  explicitBuildNumber?: string | null;
  explicitRevision?: string | number | null;
  gatewayVersion: string;
  rootDir?: string;
  sourceClean?: boolean;
  sourceSha?: string | null;
};

export type IosReleasePlan = {
  appStoreRevision: number;
  appStoreVersion: string;
  appStoreVersionId: string | null;
  appStoreVersionState: string | null;
  buildNumber: number;
  buildUploads: IosRemoteBuildUpload[];
  changelogStatus: "needs-cut" | "ready";
  decision: "new-revision" | "resume-editable" | "retry-upload";
  gatewayVersion: string;
  sourceClean: boolean | null;
  sourceSha: string | null;
};

type DecodedVersion = {
  legacy: boolean;
  revision: number;
};

function parseVersionComponents(version: string): [number, number, number] | null {
  const match = /^(\d{4})\.(\d{1,2})\.(\d+)$/u.exec(version.trim());
  if (!match) {
    return null;
  }
  const components = match.slice(1).map(Number);
  if (components.some((value) => !Number.isSafeInteger(value))) {
    return null;
  }
  return components as [number, number, number];
}

function compareAppStoreVersions(left: string, right: string): number {
  const leftComponents = parseVersionComponents(left);
  const rightComponents = parseVersionComponents(right);
  if (!leftComponents || !rightComponents) {
    throw new Error(`Unable to compare App Store versions '${left}' and '${right}'.`);
  }
  for (let index = 0; index < leftComponents.length; index += 1) {
    const difference = (leftComponents[index] ?? 0) - (rightComponents[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function decodeIosAppStoreVersion(
  gatewayVersion: string,
  appStoreVersion: string,
): DecodedVersion | null {
  const canonicalGatewayVersion = normalizePinnedIosVersion(gatewayVersion);
  const gateway = parseVersionComponents(canonicalGatewayVersion);
  const candidate = parseVersionComponents(appStoreVersion);
  if (!gateway || !candidate || gateway[0] !== candidate[0] || gateway[1] !== candidate[1]) {
    return null;
  }
  if (candidate[2] === gateway[2]) {
    return compareAppStoreVersions(canonicalGatewayVersion, LAST_LEGACY_IOS_APP_STORE_VERSION) <= 0
      ? { legacy: true, revision: 0 }
      : null;
  }
  const gatewayPatch = gateway[2].toString();
  const candidatePatch = candidate[2].toString();
  if (!candidatePatch.startsWith(gatewayPatch)) {
    return null;
  }
  const revision = candidatePatch.slice(gatewayPatch.length);
  if (!/^\d$/u.test(revision)) {
    return null;
  }
  return { legacy: false, revision: Number(revision) };
}

function normalizeBuildNumber(rawBuildNumber: string): number {
  const normalized = rawBuildNumber.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error(
      `Invalid App Store build number '${rawBuildNumber}'. Expected a positive integer.`,
    );
  }
  const buildNumber = Number(normalized);
  if (!Number.isSafeInteger(buildNumber)) {
    throw new Error(`Invalid App Store build number '${rawBuildNumber}'. Expected a safe integer.`);
  }
  return buildNumber;
}

function relevantBuildUploads(
  uploads: IosRemoteBuildUpload[],
  shortVersion: string,
): IosRemoteBuildUpload[] {
  return uploads.filter((upload) => {
    if (upload.shortVersion !== shortVersion) {
      return false;
    }
    if (!(IOS_BUILD_UPLOAD_STATES as readonly string[]).includes(upload.state)) {
      throw new Error(
        `Unknown App Store build upload state '${upload.state}' for ${upload.shortVersion} build ${upload.buildNumber}.`,
      );
    }
    normalizeBuildNumber(upload.buildNumber);
    return true;
  });
}

function nextBuildNumber(uploads: IosRemoteBuildUpload[], shortVersion: string): number {
  const builds = relevantBuildUploads(uploads, shortVersion).map((upload) =>
    normalizeBuildNumber(upload.buildNumber),
  );
  return builds.length === 0 ? 1 : Math.max(...builds) + 1;
}

function assertExplicitSelection(
  plan: Pick<IosReleasePlan, "appStoreRevision" | "buildNumber">,
  input: IosReleasePlanInput,
): void {
  if (input.explicitRevision !== null && input.explicitRevision !== undefined) {
    const explicitRevision = normalizeIosAppStoreRevision(input.explicitRevision);
    if (explicitRevision !== plan.appStoreRevision) {
      throw new Error(
        `Explicit App Store revision ${explicitRevision} does not match the deterministic revision ${plan.appStoreRevision}.`,
      );
    }
  }
  const explicitBuild = input.explicitBuildNumber?.trim() ?? "";
  if (explicitBuild) {
    const buildNumber = normalizeBuildNumber(explicitBuild);
    if (buildNumber !== plan.buildNumber) {
      throw new Error(
        `Explicit App Store build ${buildNumber} does not match the deterministic next build ${plan.buildNumber}.`,
      );
    }
  }
}

export function resolveIosReleasePlan(input: IosReleasePlanInput): IosReleasePlan {
  const gatewayVersion = normalizePinnedIosVersion(input.gatewayVersion);
  const decodedVersions = input.appStoreVersions.map((version) => ({
    decoded: decodeIosAppStoreVersion(gatewayVersion, version.versionString),
    version,
  }));
  // App Store Connect permits only one mutable iOS version. Treat any extra
  // active record as ambiguous instead of guessing which release owns it.
  const activeVersions = input.appStoreVersions.filter(
    (version) => !RELEASED_APP_STORE_VERSION_STATES.has(version.state),
  );
  if (activeVersions.length > 1) {
    throw new Error(
      `App Store Connect has multiple active iOS versions: ${activeVersions
        .map((version) => `${version.versionString} (${version.state})`)
        .join(", ")}.`,
    );
  }

  let revision: number;
  let decision: IosReleasePlan["decision"];
  let selectedVersion: IosRemoteAppStoreVersion | null = null;

  if (activeVersions.length === 1) {
    selectedVersion = activeVersions[0] ?? null;
    if (!selectedVersion || !EDITABLE_APP_STORE_VERSION_STATES.has(selectedVersion.state)) {
      throw new Error(
        `App Store version ${selectedVersion?.versionString ?? "unknown"} is locked in state ${selectedVersion?.state ?? "UNKNOWN"}.`,
      );
    }
    const decoded = decodeIosAppStoreVersion(gatewayVersion, selectedVersion.versionString);
    if (!decoded || decoded.legacy) {
      throw new Error(
        `Editable App Store version ${selectedVersion.versionString} does not belong to gateway ${gatewayVersion}.`,
      );
    }
    revision = decoded.revision;
    decision = "resume-editable";
  } else {
    const releasedRevisions = decodedVersions.flatMap(({ decoded, version }) =>
      decoded && RELEASED_APP_STORE_VERSION_STATES.has(version.state) ? [decoded.revision] : [],
    );
    let hasLegacyUpload = false;
    const uploadedRevisions = input.buildUploads.flatMap((upload) => {
      const decoded = decodeIosAppStoreVersion(gatewayVersion, upload.shortVersion);
      if (!decoded) {
        return [];
      }
      if (!(IOS_BUILD_UPLOAD_STATES as readonly string[]).includes(upload.state)) {
        throw new Error(
          `Unknown App Store build upload state '${upload.state}' for ${upload.shortVersion} build ${upload.buildNumber}.`,
        );
      }
      normalizeBuildNumber(upload.buildNumber);
      if (decoded.legacy) {
        hasLegacyUpload = true;
        return [];
      }
      return [decoded.revision];
    });
    const highestReleased = releasedRevisions.length === 0 ? -1 : Math.max(...releasedRevisions);
    const highestUploaded = uploadedRevisions.length === 0 ? -1 : Math.max(...uploadedRevisions);
    const unreleasedUploadedRevisions = [
      ...new Set(uploadedRevisions.filter((uploaded) => uploaded > highestReleased)),
    ];

    if (unreleasedUploadedRevisions.length > 1) {
      throw new Error(
        `Multiple unreleased App Store build-upload revisions exist for gateway ${gatewayVersion}: ${unreleasedUploadedRevisions.toSorted((left, right) => left - right).join(", ")}. Resolve App Store Connect state before retrying.`,
      );
    }

    // Build-upload history survives processing failures and a manually removed
    // version record, so retry that public revision until it is distributed.
    if (highestUploaded > highestReleased) {
      revision = highestUploaded;
      decision = "retry-upload";
    } else {
      const historicalRevisions = decodedVersions.flatMap(({ decoded }) =>
        decoded ? [decoded.revision] : [],
      );
      if (hasLegacyUpload) {
        historicalRevisions.push(0);
      }
      const highestHistorical =
        historicalRevisions.length === 0 ? -1 : Math.max(...historicalRevisions);
      revision = Math.max(highestHistorical, highestUploaded) + 1;
      decision = "new-revision";
    }
  }

  if (revision > MAX_IOS_APP_STORE_REVISION) {
    throw new Error(
      `Gateway ${gatewayVersion} has exhausted App Store revisions 0 through ${MAX_IOS_APP_STORE_REVISION}.`,
    );
  }

  const appStoreVersion = encodeIosAppStoreVersion(gatewayVersion, revision);
  const releasedVersions = input.appStoreVersions
    .filter((version) => RELEASED_APP_STORE_VERSION_STATES.has(version.state))
    .map((version) => version.versionString)
    .toSorted(compareAppStoreVersions);
  const latestReleasedVersion = releasedVersions.at(-1);
  if (
    latestReleasedVersion &&
    compareAppStoreVersions(appStoreVersion, latestReleasedVersion) <= 0
  ) {
    throw new Error(
      `Planned App Store version ${appStoreVersion} must be greater than latest released version ${latestReleasedVersion}.`,
    );
  }
  const uploads = relevantBuildUploads(input.buildUploads, appStoreVersion);
  const buildNumber = nextBuildNumber(input.buildUploads, appStoreVersion);
  const rootDir = path.resolve(input.rootDir ?? ".");
  const changelog = readFileSync(path.join(rootDir, "apps/ios/CHANGELOG.md"), "utf8");
  const hasReleaseNotes = Boolean(extractChangelogSection(changelog, appStoreVersion));
  const hasUnreleasedNotes = Boolean(extractChangelogSection(changelog, "Unreleased"));
  const changelogStatus = hasReleaseNotes && !hasUnreleasedNotes ? "ready" : "needs-cut";
  const plan: IosReleasePlan = {
    appStoreRevision: revision,
    appStoreVersion,
    appStoreVersionId: selectedVersion?.id ?? null,
    appStoreVersionState: selectedVersion?.state ?? null,
    buildNumber,
    buildUploads: uploads,
    changelogStatus,
    decision,
    gatewayVersion,
    sourceClean: input.sourceClean ?? null,
    sourceSha: input.sourceSha?.trim() || null,
  };
  assertExplicitSelection(plan, input);
  return plan;
}

type ChangelogSection = {
  body: string;
  end: number;
  heading: string;
  headingLine: string;
  start: number;
};

function changelogSections(content: string): ChangelogSection[] {
  const lines = content.split(/\r?\n/u);
  const starts = lines.flatMap((line, index) => (line.startsWith("## ") ? [index] : []));
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    return {
      body: lines
        .slice(start + 1, end)
        .join("\n")
        .trim(),
      end,
      heading: lines[start]?.slice(3).split(" - ", 1)[0]?.trim() ?? "",
      headingLine: lines[start] ?? "",
      start,
    };
  });
}

export function cutIosReleaseChangelog(content: string, appStoreVersion: string): string {
  const lines = content.split(/\r?\n/u);
  const sections = changelogSections(content);
  const unreleased = sections.find((section) => section.heading === "Unreleased");
  if (!unreleased) {
    throw new Error("Missing ## Unreleased section in apps/ios/CHANGELOG.md.");
  }
  const target = sections.find((section) => section.heading === appStoreVersion);
  if (!unreleased.body && !target?.body) {
    throw new Error(`No release notes are available for App Store version ${appStoreVersion}.`);
  }
  if (!unreleased.body) {
    return content;
  }

  const targetBody = [unreleased.body, target?.body].filter(Boolean).join("\n\n");
  // Retry fixes join the same public release notes. Clearing Unreleased makes
  // the cut idempotent and keeps the committed heading as upload provenance.
  const beforeUnreleased = lines.slice(0, unreleased.start);
  const afterUnreleased = lines.slice(unreleased.end);
  let nextLines = [...beforeUnreleased, "## Unreleased", ""];
  if (target) {
    const adjustedTarget = changelogSections(afterUnreleased.join("\n")).find(
      (section) => section.heading === appStoreVersion,
    );
    if (!adjustedTarget) {
      throw new Error(`Unable to locate App Store changelog section ${appStoreVersion}.`);
    }
    nextLines = [
      ...nextLines,
      ...afterUnreleased.slice(0, adjustedTarget.start),
      adjustedTarget.headingLine,
      "",
      targetBody,
      "",
      ...afterUnreleased.slice(adjustedTarget.end),
    ];
  } else {
    nextLines = [...nextLines, `## ${appStoreVersion}`, "", targetBody, "", ...afterUnreleased];
  }
  return `${nextLines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}
