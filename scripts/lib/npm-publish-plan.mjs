import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "./release-version.mjs";

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
 * @param {string | null} [currentBetaVersion]
 * @param {string | null} [publishTagOverride]
 * @returns {NpmPublishPlan}
 */
export function resolveNpmPublishPlan(version, currentBetaVersion, publishTagOverride) {
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }
  const releaseTrain = classifyReleaseTrain(parsedVersion);

  const normalizedOverride = publishTagOverride?.trim();
  if (normalizedOverride && normalizedOverride !== "extended-stable") {
    throw new Error(
      `Unsupported npm publish tag override "${normalizedOverride}". Expected "extended-stable".`,
    );
  }
  if (normalizedOverride === "extended-stable") {
    if (releaseTrain !== "extended-stable") {
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
