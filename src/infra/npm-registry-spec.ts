// Parses npm registry specs into package, version, and tag references.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const EXACT_SEMVER_VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const OPENCLAW_STABLE_CORRECTION_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-(?<correction>[1-9]\d*)$/;
const OPENCLAW_STABLE_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)$/;
const OPENCLAW_ALPHA_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-alpha\.(?<alpha>[1-9]\d*)$/;
const OPENCLAW_BETA_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-beta\.(?<beta>[1-9]\d*)$/;
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parsed monthly patch OpenClaw release version used for channel-aware ordering. */
type OpenClawReleaseVersion = {
  channel: "alpha" | "beta" | "stable";
  year: number;
  month: number;
  patch: number;
  alphaNumber?: number;
  betaNumber?: number;
  correctionNumber?: number;
};

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
  const exactVersionMatch = EXACT_SEMVER_VERSION_RE.exec(selector);
  if (exactVersionMatch) {
    return {
      ok: true,
      parsed: {
        name,
        raw: spec,
        selector,
        selectorKind: "exact-version",
        selectorIsPrerelease:
          Boolean(exactVersionMatch[4]) && !isOpenClawStableCorrectionVersion(selector),
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
  return EXACT_SEMVER_VERSION_RE.test(value.trim());
}

/** Parses OpenClaw's monthly patch stable/alpha/beta/correction version format. */
function parseOpenClawReleaseVersion(value: string): OpenClawReleaseVersion | null {
  const trimmed = value.trim();
  const candidates = [
    { match: OPENCLAW_STABLE_VERSION_RE.exec(trimmed), channel: "stable" as const },
    { match: OPENCLAW_STABLE_CORRECTION_VERSION_RE.exec(trimmed), channel: "stable" as const },
    { match: OPENCLAW_ALPHA_VERSION_RE.exec(trimmed), channel: "alpha" as const },
    { match: OPENCLAW_BETA_VERSION_RE.exec(trimmed), channel: "beta" as const },
  ];
  const candidate = candidates.find((entry) => entry.match?.groups);
  if (!candidate?.match?.groups) {
    return null;
  }

  const year = Number.parseInt(candidate.match.groups.year ?? "", 10);
  const month = Number.parseInt(candidate.match.groups.month ?? "", 10);
  const patch = Number.parseInt(candidate.match.groups.patch ?? "", 10);
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

  const correctionNumber =
    candidate.channel === "stable" && candidate.match.groups.correction
      ? Number.parseInt(candidate.match.groups.correction, 10)
      : undefined;
  // Stable correction releases share the stable channel rank; the optional
  // correction number is compared later so base stable sorts before fixes.
  const alphaNumber =
    candidate.channel === "alpha"
      ? Number.parseInt(candidate.match.groups.alpha ?? "", 10)
      : undefined;
  const betaNumber =
    candidate.channel === "beta"
      ? Number.parseInt(candidate.match.groups.beta ?? "", 10)
      : undefined;

  return {
    channel: candidate.channel,
    year,
    month,
    patch,
    correctionNumber,
    alphaNumber,
    betaNumber,
  };
}

/** Returns whether a version is an OpenClaw monthly patch stable correction release. */
export function isOpenClawStableCorrectionVersion(value: string): boolean {
  const parsed = parseOpenClawReleaseVersion(value);
  return parsed?.channel === "stable" && parsed.correctionNumber !== undefined;
}

/** Compares OpenClaw monthly patch release versions across alpha, beta, stable, and corrections. */
export function compareOpenClawReleaseVersions(left: string, right: string): number | null {
  const parsedLeft = parseOpenClawReleaseVersion(left);
  const parsedRight = parseOpenClawReleaseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }
  if (parsedLeft.year !== parsedRight.year) {
    return parsedLeft.year < parsedRight.year ? -1 : 1;
  }
  if (parsedLeft.month !== parsedRight.month) {
    return parsedLeft.month < parsedRight.month ? -1 : 1;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch < parsedRight.patch ? -1 : 1;
  }
  if (parsedLeft.channel !== parsedRight.channel) {
    const rank = { alpha: 0, beta: 1, stable: 2 };
    return rank[parsedLeft.channel] < rank[parsedRight.channel] ? -1 : 1;
  }
  if (parsedLeft.channel === "alpha") {
    return Math.sign((parsedLeft.alphaNumber ?? 0) - (parsedRight.alphaNumber ?? 0));
  }
  if (parsedLeft.channel === "beta") {
    return Math.sign((parsedLeft.betaNumber ?? 0) - (parsedRight.betaNumber ?? 0));
  }
  return Math.sign((parsedLeft.correctionNumber ?? 0) - (parsedRight.correctionNumber ?? 0));
}

/** Returns whether an exact semver value is a prerelease, excluding stable correction releases. */
export function isPrereleaseSemverVersion(value: string): boolean {
  const trimmed = value.trim();
  const match = EXACT_SEMVER_VERSION_RE.exec(trimmed);
  return Boolean(match?.[4]) && !isOpenClawStableCorrectionVersion(trimmed);
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
