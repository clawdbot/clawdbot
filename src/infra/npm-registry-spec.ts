// Parses npm registry specs into package, version, and tag references.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  parse as parseSemver,
  prerelease as parseSemverPrerelease,
  type SemVer,
  valid as validSemver,
} from "semver";
import { compareOpenClawSemver, isOpenClawCorrectionSemver } from "./semver.js";

const OPENCLAW_RELEASE_PREFIX_RE = /^\d{4}\./;
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parsed registry-only npm spec accepted by plugin install flows.
 * Selectors are limited to exact versions and dist-tags; URL/git/file specs
 * are rejected before they can execute on the gateway host.
 */
export type ParsedRegistryNpmSpec = {
  name: string;
  raw: string;
  selector?: string;
  selectorKind: "none" | "exact-version" | "tag";
  selectorIsPrerelease: boolean;
};

function parseRegistryNpmSpecInternal(
  rawSpec: string,
): { ok: true; parsed: ParsedRegistryNpmSpec } | { ok: false; error: string } {
  const spec = rawSpec.trim();
  if (!spec) {
    return { ok: false, error: "missing npm spec" };
  }
  if (/\s/.test(spec)) {
    return { ok: false, error: "unsupported npm spec: whitespace is not allowed" };
  }
  // Registry-only: no URLs, git, file, or alias protocols.
  // Keep strict: this runs on the gateway host.
  if (spec.includes("://")) {
    return { ok: false, error: "unsupported npm spec: URLs are not allowed" };
  }
  if (spec.includes("#")) {
    return { ok: false, error: "unsupported npm spec: git refs are not allowed" };
  }
  if (spec.includes(":")) {
    return { ok: false, error: "unsupported npm spec: protocol specs are not allowed" };
  }

  const at = spec.lastIndexOf("@");
  const hasSelector = at > 0;
  const name = hasSelector ? spec.slice(0, at) : spec;
  const selector = hasSelector ? spec.slice(at + 1) : "";

  // Accept only registry package names; file paths, aliases, and URL/git specs are intentionally
  // rejected before this point because plugin installs run on the gateway host.
  const unscopedName = /^[a-z0-9][a-z0-9-._~]*$/;
  const scopedName = /^@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*$/;
  const isValidName = name.startsWith("@") ? scopedName.test(name) : unscopedName.test(name);
  if (!isValidName) {
    return {
      ok: false,
      error: "unsupported npm spec: expected <name> or <name>@<version> from the npm registry",
    };
  }
  if (!hasSelector) {
    return {
      ok: true,
      parsed: {
        name,
        raw: spec,
        selectorKind: "none",
        selectorIsPrerelease: false,
      },
    };
  }
  if (!selector) {
    return { ok: false, error: "unsupported npm spec: missing version/tag after @" };
  }
  if (/[\\/]/.test(selector)) {
    return { ok: false, error: "unsupported npm spec: invalid version/tag" };
  }
  const exactVersion = validSemver(selector);
  if (exactVersion) {
    return {
      ok: true,
      parsed: {
        name,
        raw: spec,
        selector,
        selectorKind: "exact-version",
        selectorIsPrerelease:
          parseSemverPrerelease(exactVersion) !== null &&
          !isOpenClawStableCorrectionVersion(selector),
      },
    };
  }
  if (!DIST_TAG_RE.test(selector)) {
    return {
      ok: false,
      error: "unsupported npm spec: use an exact version or dist-tag (ranges are not allowed)",
    };
  }
  return {
    ok: true,
    parsed: {
      name,
      raw: spec,
      selector,
      selectorKind: "tag",
      selectorIsPrerelease: false,
    },
  };
}

/** Parses a registry-only npm package spec into package name and optional selector metadata. */
export function parseRegistryNpmSpec(rawSpec: string): ParsedRegistryNpmSpec | null {
  const parsed = parseRegistryNpmSpecInternal(rawSpec);
  return parsed.ok ? parsed.parsed : null;
}

/** Returns whether a user-provided npm spec resolves to the official OpenClaw npm scope. */
export function isOpenClawOrgNpmSpec(rawSpec: string | undefined): boolean {
  const parsed = rawSpec ? parseRegistryNpmSpec(rawSpec) : null;
  return parsed?.name.startsWith("@openclaw/") === true;
}

/** Validates a registry-only npm spec and returns a user-facing error when rejected. */
export function validateRegistryNpmSpec(rawSpec: string): string | null {
  const parsed = parseRegistryNpmSpecInternal(rawSpec);
  return parsed.ok ? null : parsed.error;
}

/** Returns whether a value is an exact semver selector, with optional leading `v`. */
export function isExactSemverVersion(value: string): boolean {
  return validSemver(value.trim()) !== null;
}

/** Parses OpenClaw's monthly patch stable/alpha/beta/correction version format. */
function parseOpenClawReleaseVersion(value: string): SemVer | null {
  const trimmed = value.trim();
  const parsed = OPENCLAW_RELEASE_PREFIX_RE.test(trimmed) ? parseSemver(trimmed) : null;
  if (!parsed || parsed.build.length > 0) {
    return null;
  }
  if (parsed.minor < 1 || parsed.minor > 12 || parsed.patch < 1) {
    return null;
  }

  const [label, sequence] = parsed.prerelease;
  const isStable = parsed.prerelease.length === 0;
  const isCorrection = isOpenClawCorrectionSemver(parsed) && typeof label === "number" && label > 0;
  const isAlpha =
    parsed.prerelease.length === 2 &&
    label === "alpha" &&
    typeof sequence === "number" &&
    sequence > 0;
  const isBeta =
    parsed.prerelease.length === 2 &&
    label === "beta" &&
    typeof sequence === "number" &&
    sequence > 0;
  if (!isStable && !isCorrection && !isAlpha && !isBeta) {
    return null;
  }
  return parsed;
}

/** Returns whether a version is an OpenClaw monthly patch stable correction release. */
function isOpenClawStableCorrectionVersion(value: string): boolean {
  const parsed = parseOpenClawReleaseVersion(value);
  return parsed !== null && isOpenClawCorrectionSemver(parsed);
}

/** Compares OpenClaw monthly patch release versions across alpha, beta, stable, and corrections. */
export function compareOpenClawReleaseVersions(left: string, right: string): number | null {
  const parsedLeft = parseOpenClawReleaseVersion(left);
  const parsedRight = parseOpenClawReleaseVersion(right);
  return parsedLeft && parsedRight ? compareOpenClawSemver(parsedLeft, parsedRight) : null;
}

/** Returns whether an exact semver value is a prerelease, excluding stable correction releases. */
export function isPrereleaseSemverVersion(value: string): boolean {
  const trimmed = value.trim();
  return parseSemverPrerelease(trimmed) !== null && !isOpenClawStableCorrectionVersion(trimmed);
}

/**
 * Enforces explicit opt-in before an npm spec may resolve to a prerelease.
 * Bare specs and `latest` stay on stable releases unless the resolved version
 * is an OpenClaw stable correction.
 */
export function isPrereleaseResolutionAllowed(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedVersion?: string;
}): boolean {
  if (!params.resolvedVersion || !isPrereleaseSemverVersion(params.resolvedVersion)) {
    return true;
  }
  // Bare specs and `latest` should not drift into beta/rc builds; prereleases require a tag or
  // exact prerelease selector so automation remains stable.
  if (params.spec.selectorKind === "none") {
    return false;
  }
  if (params.spec.selectorKind === "exact-version") {
    return params.spec.selectorIsPrerelease;
  }
  return normalizeLowercaseStringOrEmpty(params.spec.selector) !== "latest";
}

/** Formats the install error shown when a registry spec resolves to a disallowed prerelease. */
export function formatPrereleaseResolutionError(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedVersion: string;
}): string {
  const selectorHint =
    params.spec.selectorKind === "none" ||
    normalizeLowercaseStringOrEmpty(params.spec.selector) === "latest"
      ? `Use "${params.spec.name}@beta" (or another prerelease tag) or an exact prerelease version to opt in explicitly.`
      : `Use an explicit prerelease tag or exact prerelease version if you want prerelease installs.`;
  return `Resolved ${params.spec.raw} to prerelease version ${params.resolvedVersion}, but prereleases are only installed when explicitly requested. ${selectorHint}`;
}
