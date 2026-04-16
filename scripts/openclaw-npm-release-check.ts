#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  writePackageDistInventory,
} from "../src/infra/package-dist-inventory.ts";
import {
  compareReleaseVersions as compareReleaseVersionsBase,
  resolveNpmDistTagMirrorAuth as resolveNpmDistTagMirrorAuthBase,
  parseReleaseVersion as parseReleaseVersionBase,
} from "./lib/npm-publish-plan.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "./lib/workspace-bootstrap-smoke.mjs";

type PackageJson = {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  repository?: { url?: string } | string;
  bin?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

export type ParsedReleaseVersion = {
  version: string;
  baseVersion: string;
  channel: "stable" | "beta";
  year: number;
  month: number;
  day: number;
  betaNumber?: number;
  correctionNumber?: number;
  date: Date;
};

export type ParsedReleaseTag = {
  version: string;
  packageVersion: string;
  baseVersion: string;
  channel: "stable" | "beta";
  correctionNumber?: number;
  date: Date;
};

export type NpmPublishPlan = {
  channel: "stable" | "beta";
  publishTag: "latest" | "beta";
  mirrorDistTags: ("latest" | "beta")[];
};

export type NpmDistTagMirrorAuth = {
  hasAuth: boolean;
  source: "node-auth-token" | "npm-token" | "none";
};
const EXPECTED_REPOSITORY_URL = "https://github.com/openclaw/openclaw";
const MAX_CALVER_DISTANCE_DAYS = 2;
const LEGACY_UPDATE_COMPAT_PACKED_PATHS = ["dist/extensions/qa-channel/runtime-api.js"] as const;
const REQUIRED_PACKED_PATHS = [
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  "dist/control-ui/index.html",
  ...LEGACY_UPDATE_COMPAT_PACKED_PATHS,
  ...WORKSPACE_TEMPLATE_PACK_PATHS,
];
const CONTROL_UI_ASSET_PREFIX = "dist/control-ui/assets/";
const FORBIDDEN_PACKED_PATH_RULES = [
  {
    prefix: "docs/.generated/",
    describe: (packedPath: string) =>
      `npm package must not include generated docs artifact "${packedPath}".`,
  },
  {
    prefix: "dist/extensions/qa-channel/",
    describe: (packedPath: string) =>
      `npm package must not include private QA channel artifact "${packedPath}".`,
  },
  {
    prefix: "dist/extensions/qa-lab/",
    describe: (packedPath: string) =>
      `npm package must not include private QA lab artifact "${packedPath}".`,
  },
  {
    prefix: "dist/plugin-sdk/extensions/qa-lab/",
    describe: (packedPath: string) =>
      `npm package must not include private QA lab type artifact "${packedPath}".`,
  },
  {
    prefix: "dist/qa-runtime-",
    describe: (packedPath: string) =>
      `npm package must not include private QA runtime chunk "${packedPath}".`,
  },
  {
    prefix: "qa/",
    describe: (packedPath: string) =>
      `npm package must not include private QA suite artifact "${packedPath}".`,
  },
] as const;
const FORBIDDEN_PRIVATE_QA_CONTENT_MARKERS = [
  "//#region extensions/qa-lab/",
  "qa-lab/cli.js",
  "qa-lab/runtime-api.js",
] as const;
const FORBIDDEN_PRIVATE_QA_CONTENT_SCAN_PREFIXES = ["dist/"] as const;
const PACKED_TEST_CARGO_DIRECTORY_SEGMENTS = new Set([
  "__snapshots__",
  "__tests__",
  "test",
  "tests",
]);
const PACKED_TEST_CARGO_FILE_RE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;
const NPM_PACK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const skipPackValidationEnv = "OPENCLAW_NPM_RELEASE_SKIP_PACK_CHECK";

function normalizePackedPath(packedPath: string): string {
  return packedPath.replace(/\\/g, "/");
}
function isNodeModulesPackageRoot(segments: string[], index: number): boolean {
  const parent = segments[index - 1];
  if (parent === "node_modules") {
    return true;
  }
  return parent?.startsWith("@") && segments[index - 2] === "node_modules";
}

function pathContainsPackedTestCargo(packedPath: string): boolean {
  const normalizedPath = normalizePackedPath(packedPath);
  if (PACKED_TEST_CARGO_FILE_RE.test(normalizedPath)) {
    return true;
  }
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments.some(
    (segment, index) =>
      index < segments.length - 1 &&
      PACKED_TEST_CARGO_DIRECTORY_SEGMENTS.has(segment) &&
      !isNodeModulesPackageRoot(segments, index),
  );
}

function normalizeRepoUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

export function parseReleaseVersion(version: string): ParsedReleaseVersion | null {
  return parseReleaseVersionBase(version) as ParsedReleaseVersion | null;
}

export function compareReleaseVersions(left: string, right: string): number | null {
  return compareReleaseVersionsBase(left, right);
}

export function resolveNpmPublishPlan(
  version: string,
  _currentBetaVersion?: string | null,
  requestedPublishTag?: "latest" | "beta" | null,
): NpmPublishPlan {
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }

  const publishTag = requestedPublishTag?.trim() === "latest" ? "latest" : "beta";

  if (parsedVersion.channel === "beta") {
    if (publishTag !== "beta") {
      throw new Error("Beta prereleases must publish to the beta dist-tag.");
    }
    return {
      channel: "beta",
      publishTag: "beta",
      mirrorDistTags: [],
    };
  }

  return {
    channel: "stable",
    publishTag,
    mirrorDistTags: [],
  };
}

export function resolveNpmDistTagMirrorAuth(params?: {
  nodeAuthToken?: string | null;
  npmToken?: string | null;
}): NpmDistTagMirrorAuth {
  const nodeAuthToken =
    params && "nodeAuthToken" in params ? params.nodeAuthToken : process.env.NODE_AUTH_TOKEN;
  const npmToken = params && "npmToken" in params ? params.npmToken : process.env.NPM_TOKEN;
  return resolveNpmDistTagMirrorAuthBase({
    nodeAuthToken,
    npmToken,
  }) as NpmDistTagMirrorAuth;
}

export function shouldSkipPackedTarballValidation(env = process.env): boolean {
  const raw = env[skipPackValidationEnv];
  if (!raw) {
    return false;
  }
  return !/^(0|false)$/i.test(raw);
}

export function parseReleaseTagVersion(version: string): ParsedReleaseTag | null {
  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }

  const parsedVersion = parseReleaseVersion(trimmed);
  if (parsedVersion !== null) {
    return {
      version: trimmed,
      packageVersion: parsedVersion.version,
      baseVersion: parsedVersion.baseVersion,
      channel: parsedVersion.channel,
      date: parsedVersion.date,
      correctionNumber: parsedVersion.correctionNumber,
    };
  }

  return null;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function utcCalendarDayDistance(left: Date, right: Date): number {
  return Math.round(Math.abs(startOfUtcDay(left) - startOfUtcDay(right)) / 86_400_000);
}

export function collectReleasePackageMetadataErrors(pkg: PackageJson): string[] {
  const actualRepositoryUrl = normalizeRepoUrl(
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
  );
  const errors: string[] = [];

  if (pkg.name !== "openclaw") {
    errors.push(`package.json name must be "openclaw"; found "${pkg.name ?? ""}".`);
  }
  if (!pkg.description?.trim()) {
    errors.push("package.json description must be non-empty.");
  }
  if (pkg.license !== "MIT") {
    errors.push(`package.json license must be "MIT"; found "${pkg.license ?? ""}".`);
  }
  if (actualRepositoryUrl !== EXPECTED_REPOSITORY_URL) {
    errors.push(
      `package.json repository.url must resolve to ${EXPECTED_REPOSITORY_URL}; found ${
        actualRepositoryUrl || "<missing>"
      }.`,
    );
  }
  if (pkg.bin?.openclaw !== "openclaw.mjs") {
    errors.push(
      `package.json bin.openclaw must be "openclaw.mjs"; found "${pkg.bin?.openclaw ?? ""}".`,
    );
  }
  if (pkg.peerDependencies?.["node-llama-cpp"] !== "3.18.1") {
    errors.push(
      `package.json peerDependencies["node-llama-cpp"] must be "3.18.1"; found "${
        pkg.peerDependencies?.["node-llama-cpp"] ?? ""
      }".`,
    );
  }
  if (pkg.peerDependenciesMeta?.["node-llama-cpp"]?.optional !== true) {
    errors.push('package.json peerDependenciesMeta["node-llama-cpp"].optional must be true.');
  }

  return errors;
}

export function collectReleaseTagErrors(params: {
  packageVersion: string;
  releaseTag: string;
  releaseSha?: string;
  releaseMainRef?: string;
  now?: Date;
}): string[] {
  const errors: string[] = [];
  const releaseTag = params.releaseTag.trim();
  const packageVersion = params.packageVersion.trim();
  const now = params.now ?? new Date();

  const parsedVersion = parseReleaseVersion(packageVersion);
  if (parsedVersion === null) {
    errors.push(
      `package.json version must match YYYY.M.D, YYYY.M.D-N, or YYYY.M.D-beta.N; found "${packageVersion || "<missing>"}".`,
    );
  }

  if (!releaseTag.startsWith("v")) {
    errors.push(`Release tag must start with "v"; found "${releaseTag || "<missing>"}".`);
  }

  const tagVersion = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
  const parsedTag = parseReleaseTagVersion(tagVersion);
  if (parsedTag === null) {
    errors.push(
      `Release tag must match vYYYY.M.D, vYYYY.M.D-beta.N, or fallback correction tag vYYYY.M.D-N; found "${releaseTag || "<missing>"}".`,
    );
  }

  const expectedTag = packageVersion ? `v${packageVersion}` : "<missing>";
  const matchesExpectedTag =
    parsedTag !== null &&
    parsedVersion !== null &&
    parsedTag.channel === parsedVersion.channel &&
    (parsedTag.packageVersion === parsedVersion.version ||
      (parsedVersion.channel === "stable" &&
        parsedVersion.correctionNumber === undefined &&
        parsedTag.correctionNumber !== undefined &&
        parsedTag.baseVersion === parsedVersion.baseVersion));
  if (!matchesExpectedTag) {
    errors.push(
      `Release tag ${releaseTag || "<missing>"} does not match package.json version ${
        packageVersion || "<missing>"
      }; expected ${
        parsedVersion?.channel === "stable" && parsedVersion.correctionNumber === undefined
          ? `${expectedTag} or ${expectedTag}-N`
          : expectedTag
      }.`,
    );
  }

  if (parsedVersion !== null) {
    const dayDistance = utcCalendarDayDistance(parsedVersion.date, now);
    if (dayDistance > MAX_CALVER_DISTANCE_DAYS) {
      const nowLabel = now.toISOString().slice(0, 10);
      const versionDate = parsedVersion.date.toISOString().slice(0, 10);
      errors.push(
        `Release version ${packageVersion} is ${dayDistance} days away from current UTC date ${nowLabel}; release CalVer date ${versionDate} must be within ${MAX_CALVER_DISTANCE_DAYS} days.`,
      );
    }
  }

  if (params.releaseSha?.trim() && params.releaseMainRef?.trim()) {
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", params.releaseSha, params.releaseMainRef],
        { stdio: "ignore" },
      );
    } catch {
      errors.push(
        `Tagged commit ${params.releaseSha} is not contained in ${params.releaseMainRef}.`,
      );
    }
  }

  return errors;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
}

function isNpmExecPath(value: string): boolean {
  return /^npm(?:-cli)?(?:\.(?:c?js|cmd|exe))?$/.test(basename(value).toLowerCase());
}

export function resolveNpmCommandInvocation(
  params: {
    npmExecPath?: string;
    nodeExecPath?: string;
    platform?: NodeJS.Platform;
  } = {},
): { command: string; args: string[] } {
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const npmCommand = (params.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm";

  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isNpmExecPath(npmExecPath)) {
    return { command: nodeExecPath, args: [npmExecPath] };
  }

  return { command: npmCommand, args: [] };
}

function runNpmCommand(args: string[]): string {
  const invocation = resolveNpmCommandInvocation();
  return execFileSync(invocation.command, [...invocation.args, ...args], {
    encoding: "utf8",
    maxBuffer: NPM_PACK_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type NpmPackFileEntry = {
  path?: string;
};

type NpmPackResult = {
  filename?: string;
  files?: NpmPackFileEntry[];
};

type ExecFailure = Error & {
  stderr?: string | Uint8Array;
  stdout?: string | Uint8Array;
};

function toTrimmedUtf8(value: string | Uint8Array | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value).trim();
  }
  return "";
}

function describeExecFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const withStreams = error as ExecFailure;
  const details: string[] = [error.message];
  const stderr = toTrimmedUtf8(withStreams.stderr);
  const stdout = toTrimmedUtf8(withStreams.stdout);
  if (stderr) {
    details.push(`stderr: ${stderr}`);
  }
  if (stdout) {
    details.push(`stdout: ${stdout}`);
  }
  return details.join(" | ");
}

export function parseNpmPackJsonOutput(stdout: string): NpmPackResult[] | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const trailingArrayStart = trimmed.lastIndexOf("\n[");
  if (trailingArrayStart !== -1) {
    candidates.push(trimmed.slice(trailingArrayStart + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as NpmPackResult[];
      }
    } catch {
      // Try the next candidate. npm lifecycle output can prepend non-JSON logs.
    }
  }

  return null;
}

export function collectControlUiPackErrors(paths: Iterable<string>): string[] {
  const packedPaths = new Set(paths);
  const assetPaths = [...packedPaths].filter((path) => path.startsWith(CONTROL_UI_ASSET_PREFIX));
  const errors: string[] = [];

  for (const requiredPath of REQUIRED_PACKED_PATHS) {
    if (!packedPaths.has(requiredPath)) {
      errors.push(
        `npm package is missing required path "${requiredPath}". Ensure UI assets are built and included before publish.`,
      );
    }
  }

  if (assetPaths.length === 0) {
    errors.push(
      `npm package is missing Control UI asset payload under "${CONTROL_UI_ASSET_PREFIX}". Refuse release when the dashboard tarball would be empty.`,
    );
  }

  return errors;
}

function collectPackedTarballErrors(): string[] {
  const errors: string[] = [];
  let stdout = "";
  try {
    stdout = runNpmCommand(["pack", "--json", "--dry-run", "--ignore-scripts"]);
  } catch (error) {
    const message = describeExecFailure(error);
    errors.push(
      `Failed to inspect npm tarball contents via \`npm pack --json --dry-run --ignore-scripts\`: ${message}`,
    );
    return errors;
  }

  const packResults = parseNpmPackJsonOutput(stdout);
  if (!packResults) {
    errors.push("Failed to parse JSON output from `npm pack --json --dry-run --ignore-scripts`.");
    return errors;
  }
  const firstResult = packResults[0];
  if (!firstResult || !Array.isArray(firstResult.files)) {
    errors.push(
      "`npm pack --json --dry-run --ignore-scripts` did not return a files list to validate.",
    );
    return errors;
  }

  const packedPaths = new Set(
    firstResult.files
      .map((entry) => entry.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  );

  return [
    ...collectControlUiPackErrors(packedPaths),
    ...collectForbiddenPackedPathErrors(packedPaths),
    ...collectForbiddenPackedContentErrors(packedPaths),
    ...collectPackedTestCargoErrors(packedPaths),
  ];
}

export function collectForbiddenPackedPathErrors(paths: Iterable<string>): string[] {
  const errors: string[] = [];
  for (const packedPath of paths) {
    if ((LEGACY_UPDATE_COMPAT_PACKED_PATHS as readonly string[]).includes(packedPath)) {
      continue;
    }
    const matchedRule = FORBIDDEN_PACKED_PATH_RULES.find((rule) =>
      packedPath.startsWith(rule.prefix),
    );
    if (!matchedRule) {
      continue;
    }
    errors.push(matchedRule.describe(packedPath));
  }
  return errors.toSorted((left, right) => left.localeCompare(right));
}

export function collectForbiddenPackedContentErrors(
  paths: Iterable<string>,
  rootDir = process.cwd(),
): string[] {
  const textPathPattern = /\.(?:[cm]?js|d\.ts|json|md|mjs|cjs)$/u;
  const errors: string[] = [];
  for (const packedPath of paths) {
    if (
      !FORBIDDEN_PRIVATE_QA_CONTENT_SCAN_PREFIXES.some((prefix) => packedPath.startsWith(prefix))
    ) {
      continue;
    }
    if (!textPathPattern.test(packedPath)) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(pathToFileURL(join(rootDir, packedPath)), "utf8");
    } catch {
      continue;
    }
    const matchedMarker = FORBIDDEN_PRIVATE_QA_CONTENT_MARKERS.find((marker) =>
      content.includes(marker),
    );
    if (!matchedMarker) {
      continue;
    }
    errors.push(
      `npm package must not include private QA lab marker "${matchedMarker}" in "${packedPath}".`,
    );
  }
  return errors.toSorted((left, right) => left.localeCompare(right));
}

export function collectPackedTestCargoErrors(paths: Iterable<string>): string[] {
  const errors: string[] = [];
  for (const packedPath of paths) {
    if (!pathContainsPackedTestCargo(packedPath)) {
      continue;
    }
    errors.push(`npm package must not include test cargo "${packedPath}".`);
  }
  return errors.toSorted((left, right) => left.localeCompare(right));
}

async function main(): Promise<number> {
  const pkg = loadPackageJson();
  const now = new Date();
  const skipPackValidation = shouldSkipPackedTarballValidation();
  const metadataErrors = collectReleasePackageMetadataErrors(pkg);
  const tagErrors = collectReleaseTagErrors({
    packageVersion: pkg.version ?? "",
    releaseTag: process.env.RELEASE_TAG ?? "",
    releaseSha: process.env.RELEASE_SHA,
    releaseMainRef: process.env.RELEASE_MAIN_REF,
    now,
  });
  if (!skipPackValidation) {
    await writePackageDistInventory(process.cwd());
  }
  const tarballErrors = skipPackValidation ? [] : collectPackedTarballErrors();
  const errors = [...metadataErrors, ...tagErrors, ...tarballErrors];

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`openclaw-npm-release-check: ${error}`);
    }
    return 1;
  }

  const parsedVersion = parseReleaseVersion(pkg.version ?? "");
  const channel = parsedVersion?.channel ?? "unknown";
  const dayDistance =
    parsedVersion === null ? "unknown" : String(utcCalendarDayDistance(parsedVersion.date, now));
  console.log(
    `openclaw-npm-release-check: validated ${channel} release ${pkg.version} (${dayDistance} day UTC delta${skipPackValidation ? "; metadata-only" : ""}).`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
