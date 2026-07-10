// Parses OpenClaw monthly patch release versions and npm dist-tag publish plans.
const STABLE_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)$/;
const ALPHA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-alpha\.(?<alpha>[1-9]\d*)$/;
const BETA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-beta\.(?<beta>[1-9]\d*)$/;
const CORRECTION_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-(?<correction>[1-9]\d*)$/;
const JUNE_2026_PATCH_FLOOR = 5;

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
 * @property {"latest" | "alpha" | "beta" | "extended-stable"} publishTag
 * @property {("latest" | "alpha" | "beta")[]} mirrorDistTags
 */

/**
 * @typedef {"npm-readback" | "npm-mirror" | "npm-tag-repair"} PublishedNpmVersionRoute
 */

/**
 * @typedef {"match" | "missing" | "lagging" | "ahead" | "incomparable" | "conflict"} NpmDistTagVersionState
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
 * @typedef {object} NpmRegistryPackumentResult
 * @property {number} status
 * @property {boolean} ok
 * @property {unknown} packument
 */

/**
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function cancelNpmRegistryResponseBody(response) {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Fetches and consumes an npm packument within one timeout per attempt. Keeping
 * body transfer inside the retry loop prevents a headers-only success from
 * bypassing the retry budget when the registry stream stalls or truncates.
 *
 * @param {{
 *   packageName: string;
 *   packageUrl: string;
 *   attempts?: number;
 *   timeoutMs?: number;
 *   fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
 *   sleep?: (delayMs: number) => Promise<void>;
 *   createSignal?: (timeoutMs: number) => AbortSignal;
 * }} params
 * @returns {Promise<NpmRegistryPackumentResult>}
 */
export async function fetchNpmRegistryPackumentWithRetry(params) {
  const attempts = params.attempts ?? 3;
  const timeoutMs = params.timeoutMs ?? 20_000;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const sleep =
    params.sleep ??
    ((delayMs) =>
      new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  const createSignal = params.createSignal ?? ((delayMs) => AbortSignal.timeout(delayMs));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(params.packageUrl, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: createSignal(timeoutMs),
      });
    } catch (error) {
      lastError = error;
    }

    if (response) {
      if (response.status === 429 || response.status >= 500) {
        await cancelNpmRegistryResponseBody(response);
        lastError = new Error(`HTTP ${response.status}`);
      } else if (!response.ok) {
        await cancelNpmRegistryResponseBody(response);
        return { status: response.status, ok: false, packument: null };
      } else {
        let body;
        try {
          body = await response.text();
        } catch (error) {
          await cancelNpmRegistryResponseBody(response);
          lastError = error;
          body = undefined;
        }
        if (body !== undefined) {
          try {
            return {
              status: response.status,
              ok: true,
              packument: JSON.parse(body),
            };
          } catch (error) {
            await cancelNpmRegistryResponseBody(response);
            const message = error instanceof Error ? error.message : String(error);
            lastError = new Error(
              `${params.packageName}: npm publication-route probe returned invalid JSON: ${message}.`,
            );
          }
        }
      }
    }

    if (attempt < attempts) {
      await sleep(attempt * 1000);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `${params.packageName}: npm publication-route probe did not return a stable response: ${message}.`,
  );
}

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
 * @param {string | null} [publishTagOverride]
 * @returns {NpmPublishPlan}
 */
export function resolveNpmPublishPlan(version, currentBetaVersion, publishTagOverride) {
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }

  const normalizedOverride = publishTagOverride?.trim();
  if (normalizedOverride && normalizedOverride !== "extended-stable") {
    throw new Error(
      `Unsupported npm publish tag override "${normalizedOverride}". Expected "extended-stable".`,
    );
  }
  if (normalizedOverride === "extended-stable") {
    if (
      parsedVersion.channel !== "stable" ||
      parsedVersion.correctionNumber !== undefined ||
      parsedVersion.patch < 33
    ) {
      throw new Error(
        `Extended-stable npm publication requires a final YYYY.M.PATCH version with PATCH >= 33; found "${version}".`,
      );
    }
    return {
      channel: "stable",
      publishTag: "extended-stable",
      mirrorDistTags: [],
    };
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
 *   packageVersion: string;
 *   publishPlan: NpmPublishPlan;
 *   distTags: Record<string, unknown>;
 * }} params
 * @returns {PublishedNpmVersionRoute}
 */
export function resolvePublishedNpmVersionRoute(params) {
  const primaryState = classifyNpmDistTagVersion(
    params.distTags[params.publishPlan.publishTag],
    params.packageVersion,
  );
  const needsPrimaryRepair = primaryState === "missing" || primaryState === "lagging";
  if (!needsPrimaryRepair && primaryState !== "match") {
    throwUnsafeNpmDistTag(
      params.publishPlan.publishTag,
      params.distTags[params.publishPlan.publishTag],
      params.packageVersion,
      primaryState,
    );
  }

  let needsMirrorRepair = false;
  for (const distTag of params.publishPlan.mirrorDistTags) {
    const mirrorState = classifyNpmDistTagVersion(params.distTags[distTag], params.packageVersion);
    if (mirrorState === "missing" || mirrorState === "lagging") {
      needsMirrorRepair = true;
      continue;
    }
    if (mirrorState !== "match") {
      throwUnsafeNpmDistTag(distTag, params.distTags[distTag], params.packageVersion, mirrorState);
    }
  }
  if (needsPrimaryRepair) {
    return "npm-tag-repair";
  }
  return needsMirrorRepair ? "npm-mirror" : "npm-readback";
}

/**
 * @param {unknown} currentVersion
 * @param {string} targetVersion
 * @returns {NpmDistTagVersionState}
 */
function classifyNpmDistTagVersion(currentVersion, targetVersion) {
  if (currentVersion === undefined) {
    return "missing";
  }
  if (typeof currentVersion !== "string") {
    return "incomparable";
  }
  if (currentVersion === targetVersion) {
    return "match";
  }
  const comparison = compareReleaseVersions(currentVersion, targetVersion);
  if (comparison === null) {
    return "incomparable";
  }
  if (comparison < 0) {
    return "lagging";
  }
  if (comparison > 0) {
    return "ahead";
  }
  return "conflict";
}

/**
 * @param {string} distTag
 * @param {unknown} currentVersion
 * @param {string} targetVersion
 * @param {NpmDistTagVersionState} state
 * @returns {never}
 */
function throwUnsafeNpmDistTag(distTag, currentVersion, targetVersion, state) {
  throw new Error(
    `npm dist-tag "${distTag}" points to ${JSON.stringify(currentVersion)} and cannot be safely moved to "${targetVersion}" (${state}).`,
  );
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
