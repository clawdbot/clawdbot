import { setTimeout as delay } from "node:timers/promises";
import {
  createBoundedResponseTooLargeError,
  readBoundedResponseBytes,
} from "./bounded-response.mjs";
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
 * @typedef {{
 *   packageName: string;
 *   packageUrl: string;
 *   attempts?: number;
 *   timeoutMs?: number;
 *   deadlineMs?: number;
 *   fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
 *   sleep?: (delayMs: number) => Promise<void>;
 *   createSignal?: (timeoutMs: number) => AbortSignal;
 * }} NpmRegistryReadOptions
 */

class RetryableNpmRegistryError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function boundedReadLimit(value, fallback, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new Error(`Invalid npm ${label}.`);
  }
  return result;
}

function retryAfterMilliseconds(response) {
  const value = response.headers?.get("retry-after")?.trim();
  if (!value) {
    return 0;
  }
  if (/^[0-9]+$/u.test(value)) {
    return Number(value) * 1000;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

/**
 * Both headers and body belong to one attempt. Successful byte/identity
 * comparisons stay with callers and never enter this transport retry loop.
 * @template T
 * @param {NpmRegistryReadOptions} params
 * @param {{ label: string; headers?: Record<string, string>; redirect?: RequestRedirect;
 *   read: (response: Response, signal: AbortSignal) => Promise<T> }} reader
 * @returns {Promise<{ status: number; ok: boolean; body: T | null }>}
 */
async function fetchNpmRegistryWithRetry(params, reader) {
  const attempts = boundedReadLimit(params.attempts, 3, 5, "read attempts");
  const timeoutMs = boundedReadLimit(params.timeoutMs, 20_000, 60_000, "read timeout");
  const deadlineMs = Math.min(
    boundedReadLimit(
      params.deadlineMs,
      Date.now() + 180_000,
      Number.MAX_SAFE_INTEGER,
      "read deadline",
    ),
    Date.now() + 180_000,
  );
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const sleep = params.sleep ?? delay;
  const createSignal = params.createSignal ?? ((delayMs) => AbortSignal.timeout(delayMs));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`${reader.label} deadline exceeded.`);
    }
    try {
      const signal = createSignal(Math.min(timeoutMs, remainingMs));
      response = await fetchImpl(params.packageUrl, {
        headers: reader.headers,
        redirect: reader.redirect,
        signal,
      });
      if (Date.now() >= deadlineMs) {
        await cancelNpmRegistryResponseBody(response);
        throw new Error(`${reader.label} deadline exceeded.`);
      }
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        await cancelNpmRegistryResponseBody(response);
        throw new RetryableNpmRegistryError(
          `HTTP ${response.status}`,
          retryAfterMilliseconds(response),
        );
      }
      if (!response.ok) {
        await cancelNpmRegistryResponseBody(response);
        return { status: response.status, ok: false, body: null };
      }
      const body = await reader.read(response, signal);
      if (Date.now() >= deadlineMs) {
        throw new Error(`${reader.label} deadline exceeded.`);
      }
      return { status: response.status, ok: true, body };
    } catch (error) {
      if (response?.ok) {
        await cancelNpmRegistryResponseBody(response);
      }
      if (
        !(error instanceof RetryableNpmRegistryError) &&
        !["AbortError", "TimeoutError", "TypeError"].includes(error?.name) &&
        !["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(error?.code)
      ) {
        throw error;
      }
      lastError = error;
    }
    if (attempt < attempts) {
      const retryDelayMs = Math.max(attempt * 1000, lastError?.retryAfterMs ?? 0);
      if (retryDelayMs >= deadlineMs - Date.now()) {
        throw new Error(`${reader.label} deadline would be exceeded before the permitted retry.`, {
          cause: lastError,
        });
      }
      await sleep(retryDelayMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${reader.label} did not return a stable response: ${message}.`, {
    cause: lastError,
  });
}

/** @param {NpmRegistryReadOptions} params @returns {Promise<NpmRegistryPackumentResult>} */
export async function fetchNpmRegistryPackumentWithRetry(params) {
  const result = await fetchNpmRegistryWithRetry(params, {
    label: `${params.packageName}: npm publication-route probe`,
    headers: { accept: "application/vnd.npm.install-v1+json" },
    read: async (response) => {
      const body = await response.text();
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new RetryableNpmRegistryError(
          `${params.packageName}: npm publication-route probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    },
  });
  return { status: result.status, ok: result.ok, packument: result.body };
}

/** @param {NpmRegistryReadOptions & { maxBytes: number }} params */
export async function fetchNpmRegistryTarballWithRetry(params) {
  const maxBytes = boundedReadLimit(
    params.maxBytes,
    undefined,
    256 * 1024 * 1024,
    "tarball byte limit",
  );
  const label = `${params.packageName}: npm tarball readback`;
  const result = await fetchNpmRegistryWithRetry(
    { ...params, timeoutMs: params.timeoutMs ?? 60_000 },
    {
      label,
      // Redirects cannot change the registry owner selected by the verified packument.
      redirect: "manual",
      read: (response, signal) =>
        readBoundedResponseBytes(response, label, maxBytes, {
          signal,
          createTooLargeError: createBoundedResponseTooLargeError,
        }),
    },
  );
  if (!result.ok || result.body === null) {
    throw new Error(`${label} returned HTTP ${result.status}.`);
  }
  return result.body;
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
