const STABLE_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)$/;
const ALPHA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-alpha\.(?<alpha>[1-9]\d*)$/;
const BETA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-beta\.(?<beta>[1-9]\d*)$/;
const CORRECTION_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-(?<correction>[1-9]\d*)$/;
const JUNE_2026_PATCH_FLOOR = 5;
const EXTENDED_STABLE_PATCH_FLOOR = 33;

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
 * @typedef {"alpha" | "beta" | "stable" | "extended-stable" | "unsupported-extended-stable-correction"} ReleaseTrain
 */

/**
 * @param {string} version
 * @param {Record<string, string | undefined>} groups
 * @param {"stable" | "alpha" | "beta"} channel
 * @returns {ParsedReleaseVersion | null}
 */
function parseVersionParts(version, groups, channel) {
  const year = parseSafeIntegerPart(groups.year);
  const month = parseSafeIntegerPart(groups.month);
  const patch = parseSafeIntegerPart(groups.patch);
  const alphaNumber = channel === "alpha" ? parseSafeIntegerPart(groups.alpha) : undefined;
  const betaNumber = channel === "beta" ? parseSafeIntegerPart(groups.beta) : undefined;

  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(patch) ||
    month < 1 ||
    month > 12 ||
    patch < 1
  ) {
    return null;
  }
  if (channel === "beta" && (!Number.isSafeInteger(betaNumber) || (betaNumber ?? 0) < 1)) {
    return null;
  }
  if (channel === "alpha" && (!Number.isSafeInteger(alphaNumber) || (alphaNumber ?? 0) < 1)) {
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

function parseSafeIntegerPart(value) {
  const raw = value ?? "";
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
    const correctionNumber = parseSafeIntegerPart(correctionMatch.groups.correction);
    if (
      parsedCorrection === null ||
      !Number.isSafeInteger(correctionNumber) ||
      correctionNumber < 1
    ) {
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
 * Patch 33 and later final releases belong to the trailing-month
 * extended-stable line; correction suffixes are not valid on that line.
 *
 * @param {ParsedReleaseVersion} parsedVersion
 * @returns {ReleaseTrain}
 */
export function classifyReleaseTrain(parsedVersion) {
  if (parsedVersion.channel !== "stable") {
    return parsedVersion.channel;
  }
  if (parsedVersion.patch < EXTENDED_STABLE_PATCH_FLOOR) {
    return "stable";
  }
  return parsedVersion.correctionNumber === undefined
    ? "extended-stable"
    : "unsupported-extended-stable-correction";
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
