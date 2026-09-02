import { readFileSync } from "node:fs";
import { isDirectRunUrl } from "./direct-run.mjs";
import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "./release-version.mjs";

const STABLE_ALIASES = Object.freeze({
  default: Object.freeze(["latest", "main"]),
  slim: Object.freeze(["slim", "main-slim"]),
  browser: Object.freeze(["latest-browser", "main-browser"]),
});

const EXTENDED_STABLE_ALIASES = Object.freeze({
  default: Object.freeze(["extended-stable"]),
  slim: Object.freeze(["extended-stable-slim"]),
  browser: Object.freeze(["extended-stable-browser"]),
});

const NO_MOVING_ALIASES = Object.freeze({
  default: Object.freeze([]),
  slim: Object.freeze([]),
  browser: Object.freeze([]),
});

/**
 * @typedef {object} DockerReleasePolicy
 * @property {string} version
 * @property {"stable" | "extended-stable" | "beta"} channel
 * @property {{default: readonly string[], slim: readonly string[], browser: readonly string[]}} movingAliases
 */

/**
 * Keep Docker's moving channels aligned with the release-version contract.
 * Patch 33+ finals belong to the trailing-month extended-stable line; they
 * must never move the regular latest/main aliases.
 *
 * @param {string} version
 * @returns {DockerReleasePolicy}
 */
export function resolveDockerReleasePolicy(version) {
  const parsed = parseReleaseVersion(version);
  if (parsed === null) {
    throw new Error(`Unsupported Docker release version "${version}".`);
  }
  const releaseTrain = classifyReleaseTrain(parsed);
  if (releaseTrain === "alpha") {
    throw new Error("Docker alpha image publishing is disabled.");
  }
  if (releaseTrain === "beta") {
    return { version: parsed.version, channel: "beta", movingAliases: NO_MOVING_ALIASES };
  }
  if (releaseTrain === "extended-stable") {
    return {
      version: parsed.version,
      channel: "extended-stable",
      movingAliases: EXTENDED_STABLE_ALIASES,
    };
  }
  if (releaseTrain === "unsupported-extended-stable-correction") {
    throw new Error(
      `Extended-stable Docker publication requires a final YYYY.M.PATCH version; found "${version}".`,
    );
  }
  return { version: parsed.version, channel: "stable", movingAliases: STABLE_ALIASES };
}

/**
 * Resolve the newest immutable tag owned by each moving Docker channel.
 * Unsupported historical tags and prereleases do not participate.
 *
 * @param {Iterable<string>} tags
 * @returns {{stable: {tag: string, version: string}, extendedStable: {tag: string, version: string}}}
 */
export function resolveCurrentDockerReleaseTags(tags) {
  /** @type {Record<"stable" | "extended-stable", {tag: string, version: string} | null>} */
  const current = { stable: null, "extended-stable": null };
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag.startsWith("v")) {
      continue;
    }
    let policy;
    try {
      policy = resolveDockerReleasePolicy(tag.slice(1));
    } catch {
      continue;
    }
    if (policy.channel === "beta") {
      continue;
    }
    const existing = current[policy.channel];
    if (existing === null || compareReleaseVersions(policy.version, existing.version) === 1) {
      current[policy.channel] = { tag, version: policy.version };
    }
  }
  if (current.stable === null) {
    throw new Error("No stable Docker release tag found.");
  }
  if (current["extended-stable"] === null) {
    throw new Error("No extended-stable Docker release tag found.");
  }
  return { stable: current.stable, extendedStable: current["extended-stable"] };
}

/** @returns {void} */
function main() {
  const version = process.argv[2]?.trim();
  if (version === "--current") {
    const tags = readFileSync(0, "utf8").split(/\r?\n/u);
    process.stdout.write(`${JSON.stringify(resolveCurrentDockerReleaseTags(tags))}\n`);
    return;
  }
  if (!version) {
    throw new Error(
      "Usage: node scripts/lib/docker-release-policy.mjs <version> | --current < tags.txt",
    );
  }
  process.stdout.write(`${JSON.stringify(resolveDockerReleasePolicy(version))}\n`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`docker-release-policy: ${message}`);
    process.exitCode = 1;
  }
}
