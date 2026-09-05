// Tracks uploaded mobile store builds with non-tag Git refs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type MobileReleasePlatform = "ios" | "android";
type MobileReleaseCommand = "preflight" | "record" | "resolve";

type GitDeps = {
  execFileSync?: typeof execFileSync;
};

type MobileReleaseOptions = {
  build: string | null;
  command: MobileReleaseCommand;
  platform: MobileReleasePlatform;
  remote: string;
  rootDir: string;
  sha: string;
  version: string;
  versionCode: string | null;
};

type RemoteRefState = {
  ref: string;
  sha: string;
} | null;

const REF_PREFIX = "refs/openclaw/mobile-releases";
const VERSION_RE = /^20\d{2}\.(?:[1-9]\d?)\.(?:[1-9]\d*)$/u;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/u;

function git(args: string[], rootDir: string, deps: GitDeps = {}): string {
  const exec = deps.execFileSync ?? execFileSync;
  return exec("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function errorOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return JSON.stringify(value) ?? Object.prototype.toString.call(value);
}

function gitAllowFailure(
  args: string[],
  rootDir: string,
  deps: GitDeps = {},
): { ok: boolean; stdout: string; stderr: string } {
  try {
    return { ok: true, stdout: git(args, rootDir, deps), stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout = errorOutput(e.stdout);
    const stderr = errorOutput(e.stderr);
    return { ok: false, stdout, stderr };
  }
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parsePlatform(raw: string | null): MobileReleasePlatform {
  if (raw === "ios" || raw === "android") {
    return raw;
  }
  throw new Error("Missing or invalid --platform. Expected ios or android.");
}

function parseCommand(raw: string | undefined): MobileReleaseCommand {
  if (raw === "-h" || raw === "--help") {
    throw new Error(usage());
  }
  if (raw === "preflight" || raw === "record" || raw === "resolve") {
    return raw;
  }
  throw new Error(`Unknown command '${raw ?? ""}'. Expected preflight, record, or resolve.`);
}

export function parseArgs(argv: string[]): MobileReleaseOptions {
  const command = parseCommand(argv[0]);
  let build: string | null = null;
  let platform: string | null = null;
  let remote = "origin";
  let rootDir = path.resolve(".");
  let sha = "HEAD";
  let version = "";
  let versionCode: string | null = null;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--platform":
        platform = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--version":
        version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--build":
        build = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--version-code":
        versionCode = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--sha":
        sha = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--remote":
        remote = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--root":
        rootDir = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "-h":
      case "--help":
        throw new Error(usage());
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    build,
    command,
    platform: parsePlatform(platform),
    remote,
    rootDir,
    sha,
    version,
    versionCode,
  };
}

function validateVersion(version: string): string {
  const trimmed = version.trim();
  if (!VERSION_RE.test(trimmed)) {
    throw new Error(`Invalid mobile release version '${version}'. Expected YYYY.M.D.`);
  }
  return trimmed;
}

function validatePositiveInteger(label: string, value: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!POSITIVE_INTEGER_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} '${value ?? ""}'. Expected a positive integer.`);
  }
  return trimmed;
}

function androidVersionCodePrefix(version: string): string {
  const [year, rawMonth, rawPatch] = version.split(".");
  return `${year}${rawMonth?.padStart(2, "0")}${rawPatch?.padStart(2, "0")}`;
}

function validateAndroidVersionCode(version: string, versionCode: string | null): string {
  const code = validatePositiveInteger("Android versionCode", versionCode);
  const prefix = androidVersionCodePrefix(version);
  const suffix = Number.parseInt(code.slice(prefix.length), 10);
  if (
    !code.startsWith(prefix) ||
    code.length !== prefix.length + 2 ||
    !Number.isInteger(suffix) ||
    suffix < 1 ||
    suffix > 99
  ) {
    throw new Error(
      `Invalid Android versionCode '${code}'. Expected ${prefix}01 through ${prefix}99 for version ${version}.`,
    );
  }
  return code;
}

export function mobileReleaseRefFor(options: {
  build?: string | null;
  platform: MobileReleasePlatform;
  version: string;
  versionCode?: string | null;
}): string {
  const version = validateVersion(options.version);
  if (options.platform === "ios") {
    const build = validatePositiveInteger("iOS build", options.build ?? null);
    return `${REF_PREFIX}/ios/${version}-${build}`;
  }

  const versionCode = validateAndroidVersionCode(version, options.versionCode ?? null);
  return `${REF_PREFIX}/android/${version}-${versionCode}`;
}

function assertRootDir(rootDir: string): void {
  if (!existsSync(path.join(rootDir, ".git"))) {
    throw new Error(`Not a Git checkout root: ${rootDir}`);
  }
}

function resolveCommitSha(sha: string, rootDir: string, deps: GitDeps = {}): string {
  return git(["rev-parse", "--verify", `${sha}^{commit}`], rootDir, deps).trim();
}

function readRemoteRef(
  remote: string,
  ref: string,
  rootDir: string,
  deps: GitDeps = {},
): RemoteRefState {
  const result = gitAllowFailure(["ls-remote", "--refs", remote, ref], rootDir, deps);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`Failed to inspect remote release ref ${ref}: ${detail}`);
  }

  const line = result.stdout.trim();
  if (!line) {
    return null;
  }

  const [sha, remoteRef] = line.split(/\s+/u);
  if (!sha || remoteRef !== ref) {
    throw new Error(`Unexpected remote ref lookup output for ${ref}: ${line}`);
  }
  return { ref: remoteRef, sha };
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function recoveryCommand(options: { ref: string; remote: string; sha: string }): string {
  return `git push --force-with-lease=${options.ref}: ${options.remote} ${options.sha}:${options.ref}`;
}

export function preflightMobileReleaseRef(
  options: MobileReleaseOptions,
  deps: GitDeps = {},
): { ref: string; sha: string; status: "available" | "already-recorded" } {
  assertRootDir(options.rootDir);
  const ref = mobileReleaseRefFor(options);
  const sha = resolveCommitSha(options.sha, options.rootDir, deps);
  const existing = readRemoteRef(options.remote, ref, options.rootDir, deps);

  if (!existing) {
    return { ref, sha, status: "available" };
  }
  if (existing.sha === sha) {
    return { ref, sha, status: "already-recorded" };
  }

  throw new Error(
    `Mobile release ref ${ref} already points at ${existing.sha}; refusing to record ${sha}.`,
  );
}

export function recordMobileReleaseRef(
  options: MobileReleaseOptions,
  deps: GitDeps = {},
): { ref: string; sha: string; status: "created" | "already-recorded" } {
  const preflight = preflightMobileReleaseRef(options, deps);
  if (preflight.status === "already-recorded") {
    return { ...preflight, status: "already-recorded" };
  }

  const pushArgs = [
    "push",
    `--force-with-lease=${preflight.ref}:`,
    options.remote,
    `${preflight.sha}:${preflight.ref}`,
  ];
  const result = gitAllowFailure(pushArgs, options.rootDir, deps);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `Failed to create mobile release ref ${preflight.ref}. Recovery command:\n${recoveryCommand({
        ref: preflight.ref,
        remote: options.remote,
        sha: preflight.sha,
      })}\n${detail}`,
    );
  }

  const recorded = readRemoteRef(options.remote, preflight.ref, options.rootDir, deps);
  if (recorded?.sha !== preflight.sha) {
    throw new Error(
      `Mobile release ref ${preflight.ref} was not recorded at ${preflight.sha}; remote has ${recorded?.sha ?? "no ref"}.`,
    );
  }

  return { ref: preflight.ref, sha: preflight.sha, status: "created" };
}

export function resolveMobileReleaseRef(
  options: MobileReleaseOptions,
  deps: GitDeps = {},
): { ref: string; sha: string } {
  assertRootDir(options.rootDir);
  const ref = mobileReleaseRefFor(options);
  const existing = readRemoteRef(options.remote, ref, options.rootDir, deps);
  if (!existing) {
    throw new Error(`Mobile release ref ${ref} does not exist on ${options.remote}.`);
  }
  return { ref, sha: existing.sha };
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/mobile-release-ref.ts preflight --platform ios --version YYYY.M.D --build N [--sha HEAD] [--remote origin]",
    "  node --import tsx scripts/mobile-release-ref.ts record --platform android --version YYYY.M.D --version-code YYYYMMDDNN [--sha HEAD] [--remote origin]",
    "  node --import tsx scripts/mobile-release-ref.ts resolve --platform ios --version YYYY.M.D --build N [--remote origin]",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.command === "preflight") {
      const result = preflightMobileReleaseRef(options);
      const suffix =
        result.status === "already-recorded"
          ? `already records ${shortSha(result.sha)}`
          : `available for ${shortSha(result.sha)}`;
      process.stdout.write(`Mobile release ref ${result.ref} is ${suffix}.\n`);
      return 0;
    }

    if (options.command === "record") {
      const result = recordMobileReleaseRef(options);
      const verb = result.status === "already-recorded" ? "already records" : "recorded";
      process.stdout.write(`Mobile release ref ${result.ref} ${verb} ${result.sha}.\n`);
      return 0;
    }

    const result = resolveMobileReleaseRef(options);
    process.stdout.write(`${result.sha}\t${result.ref}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const exitCode = await main(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
