// Parses OpenClaw monthly patch release versions and npm dist-tag publish plans.
const STABLE_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)$/;
const ALPHA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-alpha\.(?<alpha>[1-9]\d*)$/;
const BETA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-beta\.(?<beta>[1-9]\d*)$/;
const CORRECTION_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-(?<correction>[1-9]\d*)$/;
export const JUNE_2026_PATCH_FLOOR = 5;

/**
 * @typedef {object} ParsedReleaseVersion
 * @property {string} version
 * @property {string} baseVersion
 * @property {"stable" | "alpha" | "beta"} channel
 * @property {number} year
 * @property {number} month
 * @property {number} patch
 * @property {number | undefined} [alphaNumber]
 * @property {number | undefined} [betaNumber]
 * @property {number | undefined} [correctionNumber]
 */

/**
 * @typedef {object} NpmPublishPlan
 * @property {"stable" | "alpha" | "beta"} channel
 * @property {"latest" | "alpha" | "beta"} publishTag
 * @property {("latest" | "alpha" | "beta")[]} mirrorDistTags
 */

/**
 * @typedef {object} NpmDistTagMirrorAuth
 * @property {boolean} hasAuth
 * @property {"node-auth-token" | "npm-token" | "none"} source
 */

/**
 * @typedef {"--dry-run" | "--publish"} NpmPublishMode
 */

/**
 * @param {string} version
 * @param {Record<string, string | undefined>} groups
 * @param {"stable" | "alpha" | "beta"} channel
 * @returns {ParsedReleaseVersion | null}
 */
function parseVersionParts(version, groups, channel) {
  const year = Number.parseInt(groups.year ?? "", 10);
  const month = Number.parseInt(groups.month ?? "", 10);
  const patch = Number.parseInt(groups.patch ?? "", 10);
  const alphaNumber = channel === "alpha" ? Number.parseInt(groups.alpha ?? "", 10) : undefined;
  const betaNumber = channel === "beta" ? Number.parseInt(groups.beta ?? "", 10) : undefined;

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(patch) ||
    month < 1 ||
    month > 12 ||
    patch < 1
  ) {
    return null;
  }
  if (channel === "beta" && (!Number.isInteger(betaNumber) || (betaNumber ?? 0) < 1)) {
    return null;
  }
  if (channel === "alpha" && (!Number.isInteger(alphaNumber) || (alphaNumber ?? 0) < 1)) {
    return null;
  }

  return {
    version,
    baseVersion: `${year}.${month}.${patch}`,
    channel,
    year,
    month,
    patch,
    alphaNumber,
    betaNumber,
  };
}

/**
 * @param {string} version
 * @returns {ParsedReleaseVersion | null}
 */
export function parseReleaseVersion(version) {
  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }

  const stableMatch = STABLE_VERSION_REGEX.exec(trimmed);
  if (stableMatch?.groups) {
    return parseVersionParts(trimmed, stableMatch.groups, "stable");
  }

  const alphaMatch = ALPHA_VERSION_REGEX.exec(trimmed);
  if (alphaMatch?.groups) {
    return parseVersionParts(trimmed, alphaMatch.groups, "alpha");
  }

  const betaMatch = BETA_VERSION_REGEX.exec(trimmed);
  if (betaMatch?.groups) {
    return parseVersionParts(trimmed, betaMatch.groups, "beta");
  }

  const correctionMatch = CORRECTION_VERSION_REGEX.exec(trimmed);
  if (correctionMatch?.groups) {
    const parsedCorrection = parseVersionParts(trimmed, correctionMatch.groups, "stable");
    const correctionNumber = Number.parseInt(correctionMatch.groups.correction ?? "", 10);
    if (parsedCorrection === null || !Number.isInteger(correctionNumber) || correctionNumber < 1) {
      return null;
    }

    return {
      ...parsedCorrection,
      correctionNumber,
    };
  }

  return null;
}

/**
 * @param {string | ParsedReleaseVersion | null} version
 * @returns {string[]}
 */
export function collectReleaseVersionFloorErrors(version) {
  const parsedVersion =
    typeof version === "string" ? parseReleaseVersion(version) : (version ?? null);
  if (parsedVersion === null) {
    return [];
  }
  if (
    parsedVersion.year === 2026 &&
    parsedVersion.month === 6 &&
    parsedVersion.patch < JUNE_2026_PATCH_FLOOR &&
    parsedVersion.channel !== "alpha"
  ) {
    return [
      `June 2026 stable and beta release trains must use patch ${JUNE_2026_PATCH_FLOOR} or higher because 2026.6.5-beta.1 is already published; found "${parsedVersion.version}".`,
    ];
  }
  return [];
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number | null}
 */
export function compareReleaseVersions(left, right) {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);
  if (parsedLeft === null || parsedRight === null) {
    return null;
  }

  if (parsedLeft.year !== parsedRight.year) {
    return Math.sign(parsedLeft.year - parsedRight.year);
  }
  if (parsedLeft.month !== parsedRight.month) {
    return Math.sign(parsedLeft.month - parsedRight.month);
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return Math.sign(parsedLeft.patch - parsedRight.patch);
  }

  if (parsedLeft.channel !== parsedRight.channel) {
    const rank = { alpha: 0, beta: 1, stable: 2 };
    return Math.sign(rank[parsedLeft.channel] - rank[parsedRight.channel]);
  }

  if (parsedLeft.channel === "alpha" && parsedRight.channel === "alpha") {
    return Math.sign((parsedLeft.alphaNumber ?? 0) - (parsedRight.alphaNumber ?? 0));
  }

  if (parsedLeft.channel === "beta" && parsedRight.channel === "beta") {
    return Math.sign((parsedLeft.betaNumber ?? 0) - (parsedRight.betaNumber ?? 0));
  }

  return Math.sign((parsedLeft.correctionNumber ?? 0) - (parsedRight.correctionNumber ?? 0));
}

/**
 * @param {string} version
 * @param {string | null} [currentBetaVersion]
 * @returns {NpmPublishPlan}
 */
export function resolveNpmPublishPlan(version, currentBetaVersion) {
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }

  if (parsedVersion.channel === "beta") {
    return {
      channel: "beta",
      publishTag: "beta",
      mirrorDistTags: [],
    };
  }
  if (parsedVersion.channel === "alpha") {
    return {
      channel: "alpha",
      publishTag: "alpha",
      mirrorDistTags: [],
    };
  }

  const normalizedCurrentBeta = currentBetaVersion?.trim();
  if (normalizedCurrentBeta) {
    const betaVsStable = compareReleaseVersions(normalizedCurrentBeta, version);
    if (betaVsStable !== null && betaVsStable > 0) {
      return {
        channel: "stable",
        publishTag: "latest",
        mirrorDistTags: [],
      };
    }
  }

  return {
    channel: "stable",
    publishTag: "latest",
    mirrorDistTags: ["beta"],
  };
}

/**
 * @param {{
 *   nodeAuthToken?: string | null | undefined;
 *   npmToken?: string | null | undefined;
 * }} [params]
 * @returns {NpmDistTagMirrorAuth}
 */
export function resolveNpmDistTagMirrorAuth(params = {}) {
  const nodeAuthToken = params.nodeAuthToken?.trim();
  if (nodeAuthToken) {
    return { hasAuth: true, source: "node-auth-token" };
  }

  const npmToken = params.npmToken?.trim();
  if (npmToken) {
    return { hasAuth: true, source: "npm-token" };
  }

  return { hasAuth: false, source: "none" };
}

/**
 * @param {{
 *   mode: NpmPublishMode;
 *   mirrorDistTags: string[] | readonly string[];
 *   hasAuth: boolean;
 * }} params
 * @returns {boolean}
 */
export function shouldRequireNpmDistTagMirrorAuth(params) {
  return (
    params.mode === "--publish" &&
    params.mirrorDistTags.some((distTag) => distTag.trim().length > 0) &&
    !params.hasAuth
  );
}
