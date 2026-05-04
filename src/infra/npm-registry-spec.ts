import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const EXACT_SEMVER_VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const OPENCLAW_STABLE_CORRECTION_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-(?<correction>[1-9]\d*)$/;
const OPENCLAW_STABLE_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)$/;
const OPENCLAW_ALPHA_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-alpha\.(?<alpha>[1-9]\d*)$/;
const OPENCLAW_BETA_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-beta\.(?<beta>[1-9]\d*)$/;
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type OpenClawReleaseVersion = {
  channel: "alpha" | "beta" | "stable";
  dateTime: number;
  alphaNumber?: number;
  betaNumber?: number;
  correctionNumber?: number;
};

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

export function parseRegistryNpmSpec(rawSpec: string): ParsedRegistryNpmSpec | null {
  const parsed = parseRegistryNpmSpecInternal(rawSpec);
  return parsed.ok ? parsed.parsed : null;
}

export function validateRegistryNpmSpec(rawSpec: string): string | null {
  const parsed = parseRegistryNpmSpecInternal(rawSpec);
  return parsed.ok ? null : parsed.error;
}

export function isExactSemverVersion(value: string): boolean {
  return EXACT_SEMVER_VERSION_RE.test(value.trim());
}

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
  const day = Number.parseInt(candidate.match.groups.day ?? "", 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const correctionNumber =
    candidate.channel === "stable" && candidate.match.groups.correction
      ? Number.parseInt(candidate.match.groups.correction, 10)
      : undefined;
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
    dateTime: date.getTime(),
    correctionNumber,
    alphaNumber,
    betaNumber,
  };
}

export function isOpenClawStableCorrectionVersion(value: string): boolean {
  const parsed = parseOpenClawReleaseVersion(value);
  return parsed?.channel === "stable" && parsed.correctionNumber !== undefined;
}

export function compareOpenClawReleaseVersions(left: string, right: string): number | null {
  const parsedLeft = parseOpenClawReleaseVersion(left);
  const parsedRight = parseOpenClawReleaseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }
  if (parsedLeft.dateTime !== parsedRight.dateTime) {
    return parsedLeft.dateTime < parsedRight.dateTime ? -1 : 1;
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

export function isPrereleaseSemverVersion(value: string): boolean {
  const trimmed = value.trim();
  const match = EXACT_SEMVER_VERSION_RE.exec(trimmed);
  return Boolean(match?.[4]) && !isOpenClawStableCorrectionVersion(trimmed);
}

export function isPrereleaseResolutionAllowed(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedVersion?: string;
}): boolean {
  if (!params.resolvedVersion || !isPrereleaseSemverVersion(params.resolvedVersion)) {
    return true;
  }
  if (params.spec.selectorKind === "none") {
    return false;
  }
  if (params.spec.selectorKind === "exact-version") {
    return params.spec.selectorIsPrerelease;
  }
  return normalizeLowercaseStringOrEmpty(params.spec.selector) !== "latest";
}

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
