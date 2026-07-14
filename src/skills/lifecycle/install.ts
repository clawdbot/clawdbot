// Skill install service coordinates skill installation from archives, URLs, and registries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveBrewExecutable as defaultResolveBrewExecutable } from "../../infra/brew.js";
import { isContainerEnvironment as defaultIsContainerEnvironment } from "../../infra/container-environment.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  evaluateSkillInstallPolicy,
  type SkillInstallSpecMetadata,
} from "../../plugins/install-security-scan.js";
import { runCommandWithTimeout, type CommandOptions } from "../../process/exec.js";
import { resolveUserPath } from "../../utils.js";
import {
  hasBinary as defaultHasBinary,
  resolveSkillsInstallPreferences as defaultResolveSkillsInstallPreferences,
} from "../loading/config.js";
import { resolveSkillSource } from "../loading/source.js";
import { loadWorkspaceSkillEntries as defaultLoadWorkspaceSkillEntries } from "../loading/workspace.js";
import type { SkillEntry, SkillInstallSpec, SkillsInstallPreferences } from "../types.js";
import { installDownloadSpec } from "./install-download.js";
import { formatInstallFailureMessage } from "./install-output.js";
import type { SkillInstallResult, SkillInstallSkipReason } from "./install-types.js";

type SkillInstallRequest = {
  workspaceDir: string;
  skillName: string;
  installId: string;
  timeoutMs?: number;
  config?: OpenClawConfig;
};
export type { SkillInstallSkipReason } from "./install-types.js";

type SkillsInstallDeps = {
  hasBinary: (bin: string) => boolean;
  loadWorkspaceSkillEntries: typeof defaultLoadWorkspaceSkillEntries;
  resolveNodeInstallStateDir: () => string;
  resolveBrewExecutable: () => string | undefined;
  isContainerEnvironment: () => boolean;
  resolveSkillsInstallPreferences: typeof defaultResolveSkillsInstallPreferences;
};

const defaultSkillsInstallDeps: SkillsInstallDeps = {
  hasBinary: defaultHasBinary,
  loadWorkspaceSkillEntries: defaultLoadWorkspaceSkillEntries,
  resolveNodeInstallStateDir: resolveDefaultNodeInstallStateDir,
  resolveBrewExecutable: defaultResolveBrewExecutable,
  isContainerEnvironment: defaultIsContainerEnvironment,
  resolveSkillsInstallPreferences: defaultResolveSkillsInstallPreferences,
};

let skillsInstallDeps = defaultSkillsInstallDeps;

function getSkillsInstallDeps(): SkillsInstallDeps {
  return skillsInstallDeps;
}

function withWarnings(result: SkillInstallResult, warnings: string[]): SkillInstallResult {
  if (warnings.length === 0) {
    return result;
  }
  return {
    ...result,
    warnings: warnings.slice(),
  };
}

function resolveInstallId(spec: SkillInstallSpec, index: number): string {
  return (spec.id ?? `${spec.kind}-${index}`).trim();
}

function findInstallSpec(entry: SkillEntry, installId: string): SkillInstallSpec | undefined {
  const specs = entry.metadata?.install ?? [];
  for (const [index, spec] of specs.entries()) {
    if (resolveInstallId(spec, index) === installId) {
      return spec;
    }
  }
  return undefined;
}

function normalizeSkillInstallSpec(spec: SkillInstallSpec): SkillInstallSpecMetadata {
  return {
    ...(spec.id ? { id: spec.id } : {}),
    kind: spec.kind,
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.bins ? { bins: spec.bins.slice() } : {}),
    ...(spec.os ? { os: spec.os.slice() } : {}),
    ...(spec.formula ? { formula: spec.formula } : {}),
    ...(spec.package ? { package: spec.package } : {}),
    ...(spec.module ? { module: spec.module } : {}),
    ...(spec.url ? { url: spec.url } : {}),
    ...(spec.archive ? { archive: spec.archive } : {}),
    ...(spec.extract !== undefined ? { extract: spec.extract } : {}),
    ...(spec.stripComponents !== undefined ? { stripComponents: spec.stripComponents } : {}),
    ...(spec.targetDir ? { targetDir: spec.targetDir } : {}),
  };
}

function buildNodeInstallCommand(packageName: string, prefs: SkillsInstallPreferences): string[] {
  switch (prefs.nodeManager) {
    case "pnpm":
      return ["pnpm", "add", "-g", "--ignore-scripts", packageName];
    case "yarn":
      return ["yarn", "global", "add", "--ignore-scripts", packageName];
    case "bun":
      return ["bun", "add", "-g", "--ignore-scripts", packageName];
    default:
      return ["npm", "install", "-g", "--ignore-scripts", packageName];
  }
}

function resolveDefaultNodeInstallStateDir({
  cwd = process.cwd(),
  getuid = process.getuid?.bind(process),
  homedir = os.homedir,
  platform = process.platform,
}: {
  cwd?: string;
  getuid?: () => number;
  homedir?: () => string;
  platform?: NodeJS.Platform;
} = {}): string {
  if (platform !== "win32" && getuid?.() === 0) {
    return path.join(path.parse(cwd).root, "var", "lib", "openclaw");
  }
  return path.join(homedir(), ".openclaw");
}

async function buildNodeInstallEnv(prefs: SkillsInstallPreferences): Promise<NodeJS.ProcessEnv> {
  if (prefs.nodeManager !== "npm") {
    return {};
  }

  const stateDir = getSkillsInstallDeps().resolveNodeInstallStateDir();
  const prefix = path.join(stateDir, "tools", "node", "npm");
  await fs.promises.mkdir(prefix, { recursive: true, mode: 0o700 });
  return {
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
  };
}

// Strict allowlist patterns to prevent option injection and malicious package names.
const SAFE_BREW_FORMULA = /^[a-z0-9][a-z0-9+._@-]*(\/[a-z0-9][a-z0-9+._@-]*){0,2}$/;
const SAFE_NODE_PACKAGE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9^~>=<.*|-]+)?$/;
const SAFE_GO_MODULE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*@[a-z0-9v._-]+$/;
const SAFE_UV_PACKAGE =
  /^[a-z0-9][a-z0-9._-]*(\[[a-z0-9,._-]+\])?(([><=!~]=?|===?)[a-z0-9.*_-]+)?$/i;

function assertSafeInstallerValue(value: string, kind: string, pattern: RegExp): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    return `${kind} value is empty or starts with a dash`;
  }
  if (!pattern.test(trimmed)) {
    return `${kind} value contains invalid characters: ${trimmed}`;
  }
  return null;
}

function buildInstallCommand(
  spec: SkillInstallSpec,
  prefs: SkillsInstallPreferences,
): {
  argv: string[] | null;
  error?: string;
} {
  switch (spec.kind) {
    case "brew": {
      if (!spec.formula) {
        return { argv: null, error: "missing brew formula" };
      }
      const err = assertSafeInstallerValue(spec.formula, "brew formula", SAFE_BREW_FORMULA);
      if (err) {
        return { argv: null, error: err };
      }
      return { argv: ["brew", "install", spec.formula.trim()] };
    }
    case "node": {
      if (!spec.package) {
        return { argv: null, error: "missing node package" };
      }
      const err = assertSafeInstallerValue(spec.package, "node package", SAFE_NODE_PACKAGE);
      if (err) {
        return { argv: null, error: err };
      }
      return {
        argv: buildNodeInstallCommand(spec.package.trim(), prefs),
      };
    }
    case "go": {
      if (!spec.module) {
        return { argv: null, error: "missing go module" };
      }
      const err = assertSafeInstallerValue(spec.module, "go module", SAFE_GO_MODULE);
      if (err) {
        return { argv: null, error: err };
      }
      return { argv: ["go", "install", spec.module.trim()] };
    }
    case "uv": {
      if (!spec.package) {
        return { argv: null, error: "missing uv package" };
      }
      const err = assertSafeInstallerValue(spec.package, "uv package", SAFE_UV_PACKAGE);
      if (err) {
        return { argv: null, error: err };
      }
      return { argv: ["uv", "tool", "install", spec.package.trim()] };
    }
    case "download": {
      return { argv: null, error: "download install handled separately" };
    }
    default:
      return { argv: null, error: "unsupported installer" };
  }
}

async function resolveBrewPrefixBinDir(
  timeoutMs: number,
  brewExe: string,
): Promise<string | undefined> {
  const prefixResult = await runCommandSafely([brewExe, "--prefix"], {
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
  if (prefixResult.code === 0) {
    const prefix = prefixResult.stdout.trim();
    if (prefix) {
      return path.join(prefix, "bin");
    }
  }
  return undefined;
}

async function resolveBrewBinDir(timeoutMs: number, brewExe?: string): Promise<string | undefined> {
  const deps = getSkillsInstallDeps();
  const exe = brewExe ?? (deps.hasBinary("brew") ? "brew" : deps.resolveBrewExecutable());
  if (!exe) {
    return undefined;
  }

  const prefixBin = await resolveBrewPrefixBinDir(timeoutMs, exe);
  if (prefixBin) {
    return prefixBin;
  }

  for (const candidate of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function createInstallFailure(params: {
  message: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  skipReason?: SkillInstallSkipReason;
}): SkillInstallResult {
  return {
    ok: false,
    message: params.message,
    stdout: params.stdout?.trim() ?? "",
    stderr: params.stderr?.trim() ?? "",
    code: params.code ?? null,
    ...(params.skipReason ? { skipReason: params.skipReason } : {}),
  };
}

function createInstallSuccess(result: CommandResult): SkillInstallResult {
  return {
    ok: true,
    message: "Installed",
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}

async function runCommandSafely(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<CommandResult> {
  try {
    const result = await runCommandWithTimeout(argv, optionsOrTimeout);
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      code: null,
      stdout: "",
      stderr: formatErrorMessage(err),
    };
  }
}

function resolveBrewMissingFailure(spec: SkillInstallSpec): SkillInstallResult {
  const formula = spec.formula ?? "this package";
  if (process.platform === "linux" && getSkillsInstallDeps().isContainerEnvironment()) {
    return createInstallFailure({
      message: `brew not installed — Homebrew is not installed in this Linux container. Build a custom image with Homebrew or install "${formula}" manually using a supported system package before enabling this skill.`,
    });
  }
  const hint =
    process.platform === "linux"
      ? `Homebrew is not installed. Install it from https://brew.sh or install "${formula}" manually using your system package manager (e.g. apt, dnf, pacman).`
      : "Homebrew is not installed. Install it from https://brew.sh";
  return createInstallFailure({ message: `brew not installed — ${hint}` });
}

async function ensureUvInstalled(params: {
  spec: SkillInstallSpec;
  brewExe?: string;
  timeoutMs: number;
}): Promise<SkillInstallResult | undefined> {
  if (params.spec.kind !== "uv" || getSkillsInstallDeps().hasBinary("uv")) {
    return undefined;
  }

  if (!params.brewExe) {
    return createInstallFailure({
      message:
        "uv not installed — install manually: https://docs.astral.sh/uv/getting-started/installation/",
    });
  }

  const brewResult = await runCommandSafely([params.brewExe, "install", "uv"], {
    timeoutMs: params.timeoutMs,
  });
  if (brewResult.code === 0) {
    return undefined;
  }

  return createInstallFailure({
    message: "Failed to install uv (brew)",
    ...brewResult,
  });
}

// Go 1.21 is the onboarding auto-install baseline. Module-specific toolchain
// requirements stay with `go install`, which can honor local, path, or automatic
// switching according to the user's GOTOOLCHAIN setting.
const MIN_AUTO_GO_MAJOR = 1;
const MIN_AUTO_GO_MINOR = 21;
export const MIN_AUTO_GO_VERSION = `${MIN_AUTO_GO_MAJOR}.${MIN_AUTO_GO_MINOR}`;

const APT_GO_PACKAGE = "golang-go";
const APT_GO_POLICY_ARGV = ["apt-cache", "policy", APT_GO_PACKAGE];
const APT_GO_UPDATE_ARGV = ["apt-get", "update", "-qq"];
const APT_GO_INSTALL_ARGV = ["apt-get", "install", "-y", APT_GO_PACKAGE];
const SUDO_NONINTERACTIVE_PREFIX = ["sudo", "-n"];
const SUDO_APT_GO_CHECK_ARGVS = [
  ["sudo", "-k", "-n", "-ll", ...APT_GO_UPDATE_ARGV],
  ["sudo", "-k", "-n", "-ll", ...APT_GO_INSTALL_ARGV],
];
const GO_VERSION_ENV_ARGV = ["go", "env", "GOVERSION"];

type GoVersion = { major: number; minor: number };

type AptCommandAccess =
  | { available: true; prefix: string[] }
  | {
      available: false;
      reason: "sudo-missing" | "sudo-unusable";
      failure?: CommandResult;
    };

type GoAptCandidateResult =
  | { usable: true }
  | {
      usable: false;
      kind: "error";
      failure: CommandResult;
    }
  | {
      usable: false;
      kind: "unavailable";
    };

function isSupportedGoVersion(version: GoVersion): boolean {
  return (
    version.major > MIN_AUTO_GO_MAJOR ||
    (version.major === MIN_AUTO_GO_MAJOR && version.minor >= MIN_AUTO_GO_MINOR)
  );
}

function parseAptGoCandidate(output: string): GoVersion | undefined {
  const match = /Candidate:\s*(?:\d+:)?(\d+)\.(\d+)/.exec(output);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function appendPathDirectory(pathEnv: string | undefined, directory: string): string {
  if ((pathEnv ?? "").split(path.delimiter).includes(directory)) {
    return pathEnv ?? directory;
  }
  return pathEnv ? `${pathEnv}${path.delimiter}${directory}` : directory;
}

function sudoListAllowsPasswordlessCommand(output: string): boolean {
  const optionsLine = output.split(/\r?\n/).find((line) => /^\s*Options:\s*/.test(line));
  if (!optionsLine) {
    return false;
  }
  return optionsLine
    .slice(optionsLine.indexOf(":") + 1)
    .split(",")
    .some((option) => option.trim() === "!authenticate");
}

async function resolveAptCommandAccess(): Promise<AptCommandAccess> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { available: true, prefix: [] };
  }
  if (!getSkillsInstallDeps().hasBinary("sudo")) {
    return { available: false, reason: "sudo-missing" };
  }
  for (const argv of SUDO_APT_GO_CHECK_ARGVS) {
    const sudoCheck = await runCommandSafely(argv, {
      timeoutMs: 5_000,
      env: { LC_ALL: "C" },
    });
    if (sudoCheck.code !== 0) {
      return { available: false, reason: "sudo-unusable", failure: sudoCheck };
    }
    if (!sudoListAllowsPasswordlessCommand(sudoCheck.stdout)) {
      return {
        available: false,
        reason: "sudo-unusable",
        failure: {
          code: 1,
          stdout: sudoCheck.stdout,
          stderr: sudoCheck.stderr || "sudo rule requires authentication",
        },
      };
    }
  }
  return { available: true, prefix: SUDO_NONINTERACTIVE_PREFIX };
}

async function readGoAptCandidate(timeoutMs: number): Promise<{
  candidate?: GoVersion;
  failure?: CommandResult;
}> {
  const policy = await runCommandSafely(APT_GO_POLICY_ARGV, {
    timeoutMs: Math.min(timeoutMs, 10_000),
    env: { LC_ALL: "C" },
  });
  if (policy.code !== 0) {
    return { failure: policy };
  }
  return { candidate: parseAptGoCandidate(policy.stdout) };
}

async function resolveGoAptInstallCandidate(params: {
  prefix: string[];
  timeoutMs: number;
}): Promise<GoAptCandidateResult> {
  const update = await runCommandSafely([...params.prefix, ...APT_GO_UPDATE_ARGV], {
    timeoutMs: params.timeoutMs,
  });
  const policy = await readGoAptCandidate(params.timeoutMs);
  if (policy.failure) {
    return { usable: false, kind: "error", failure: policy.failure };
  }
  if (policy.candidate) {
    return isSupportedGoVersion(policy.candidate)
      ? { usable: true }
      : { usable: false, kind: "unavailable" };
  }
  return update.code === 0
    ? { usable: false, kind: "unavailable" }
    : { usable: false, kind: "error", failure: update };
}

async function installGoViaApt(timeoutMs: number): Promise<SkillInstallResult | undefined> {
  const aptFailureMessage =
    "go not installed — automatic install via apt failed. Install manually: https://go.dev/doc/install";
  const access = await resolveAptCommandAccess();
  if (!access.available && access.reason === "sudo-missing") {
    return createInstallFailure({
      message:
        "go not installed — apt-get is available but sudo is not installed. Install manually: https://go.dev/doc/install",
    });
  }
  if (!access.available) {
    return createInstallFailure({
      message:
        "go not installed — apt-get is available but sudo is not usable (missing or requires a password). Install manually: https://go.dev/doc/install",
      ...access.failure,
    });
  }

  const candidate = await resolveGoAptInstallCandidate({
    prefix: access.prefix,
    timeoutMs,
  });
  if (!candidate.usable) {
    return createInstallFailure({
      message:
        candidate.kind === "unavailable"
          ? `go not installed — apt does not provide a usable Go ${MIN_AUTO_GO_VERSION}+ package. Install manually: https://go.dev/doc/install`
          : aptFailureMessage,
      ...(candidate.kind === "error" ? candidate.failure : {}),
      ...(candidate.kind === "unavailable" ? { skipReason: "go" as const } : {}),
    });
  }

  const aptResult = await runCommandSafely([...access.prefix, ...APT_GO_INSTALL_ARGV], {
    timeoutMs,
  });
  if (aptResult.code === 0) {
    return undefined;
  }

  return createInstallFailure({
    message: aptFailureMessage,
    ...aptResult,
  });
}

async function ensureGoInstalled(params: {
  spec: SkillInstallSpec;
  brewExe?: string;
  timeoutMs: number;
}): Promise<SkillInstallResult | undefined> {
  if (params.spec.kind !== "go" || getSkillsInstallDeps().hasBinary("go")) {
    return undefined;
  }

  if (params.brewExe) {
    const brewResult = await runCommandSafely([params.brewExe, "install", "go"], {
      timeoutMs: params.timeoutMs,
    });
    if (brewResult.code === 0) {
      return undefined;
    }
    return createInstallFailure({
      message: "Failed to install go (brew)",
      ...brewResult,
    });
  }

  if (getSkillsInstallDeps().hasBinary("apt-get")) {
    return installGoViaApt(params.timeoutMs);
  }

  return createInstallFailure({
    message: "go not installed — install manually: https://go.dev/doc/install",
  });
}

export type SkillInstallReadiness =
  | { ready: true }
  | { ready: false; reason: SkillInstallSkipReason };

function parseGoVersion(output: string): GoVersion | undefined {
  const match = /\bgo(\d+)\.(\d+)(?:[.\w-]*)?\b/.exec(output);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

async function isGoUsableForAutoInstall(): Promise<boolean> {
  const versionResult = await runCommandSafely(GO_VERSION_ENV_ARGV, {
    timeoutMs: 5_000,
    env: { GOTOOLCHAIN: "local" },
  });
  if (versionResult.code !== 0) {
    return false;
  }
  const version = parseGoVersion(versionResult.stdout);
  return version !== undefined && isSupportedGoVersion(version);
}

function isGoToolchainPrerequisiteFailure(result: SkillInstallResult): boolean {
  const output = `${result.message}\n${result.stdout}\n${result.stderr}`;
  return (
    /requires go >= \S+ \(running go \S+(?:; GOTOOLCHAIN=[^)]+)?\)/i.test(output) ||
    /invalid GOTOOLCHAIN/i.test(output) ||
    /cannot find "go[^"]+" in PATH/i.test(output)
  );
}

async function canBootstrapGoViaApt(): Promise<boolean> {
  if (!getSkillsInstallDeps().hasBinary("apt-get")) {
    return false;
  }
  const access = await resolveAptCommandAccess();
  return access.available;
}

/**
 * Preflight twin of installSkill's prerequisite fallbacks (brew exe, ensureUvInstalled,
 * ensureGoInstalled/installGoViaApt). Says whether a recipe kind can run without manual
 * setup so callers can skip doomed installs; keep in lockstep with those fallbacks.
 *
 * uv bootstraps count only on-PATH brew because the recipe still spawns bare `uv`.
 * Go installs can use a resolved brew prefix because installSkill carries that bin
 * into the child and current PATH. Brew recipes swap argv[0] to the resolved path.
 */
export async function resolveInstallerKindReadiness(kind: string): Promise<SkillInstallReadiness> {
  const deps = getSkillsInstallDeps();
  const brewOnPath = deps.hasBinary("brew");
  const brewExe = brewOnPath ? "brew" : deps.resolveBrewExecutable();
  switch (kind) {
    case "brew":
      return brewExe ? { ready: true } : { ready: false, reason: "brew" };
    case "uv": {
      if (deps.hasBinary("uv")) {
        return { ready: true };
      }
      return brewOnPath ? { ready: true } : { ready: false, reason: "uv" };
    }
    case "go": {
      if (deps.hasBinary("go")) {
        return (await isGoUsableForAutoInstall())
          ? { ready: true }
          : { ready: false, reason: "go" };
      }
      if (brewOnPath) {
        return { ready: true };
      }
      if (brewExe) {
        return (await resolveBrewPrefixBinDir(10_000, brewExe))
          ? { ready: true }
          : { ready: false, reason: "go" };
      }
      return (await canBootstrapGoViaApt()) ? { ready: true } : { ready: false, reason: "go" };
    }
    default:
      return { ready: true };
  }
}

async function executeInstallCommand(params: {
  argv: string[] | null;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillInstallResult> {
  if (!params.argv || params.argv.length === 0) {
    return createInstallFailure({ message: "invalid install command" });
  }

  const result = await runCommandSafely(params.argv, {
    timeoutMs: params.timeoutMs,
    env: params.env,
  });
  if (result.code === 0) {
    return createInstallSuccess(result);
  }

  return createInstallFailure({
    message: formatInstallFailureMessage(result),
    ...result,
  });
}

export async function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 300_000, 1_000), 900_000);
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const deps = getSkillsInstallDeps();
  const entries = deps.loadWorkspaceSkillEntries(workspaceDir);
  const entry = entries.find((item) => item.skill.name === params.skillName);
  if (!entry) {
    return {
      ok: false,
      message: `Skill not found: ${params.skillName}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const spec = findInstallSpec(entry, params.installId);
  const warnings: string[] = [];
  const skillSource = resolveSkillSource(entry.skill);
  const normalizedSpec = spec ? normalizeSkillInstallSpec(spec) : undefined;
  const scanResult = await evaluateSkillInstallPolicy({
    config: params.config,
    installId: params.installId,
    ...(normalizedSpec ? { installSpec: normalizedSpec } : {}),
    logger: {
      warn: (message) => warnings.push(message),
    },
    origin: {
      type: skillSource,
      skillName: params.skillName,
      installId: params.installId,
    },
    source:
      skillSource === "openclaw-bundled"
        ? { kind: "bundled", authority: "openclaw", mutable: false, network: false }
        : skillSource === "openclaw-managed" || skillSource === "openclaw-extra"
          ? { kind: "managed", authority: "openclaw", mutable: false, network: false }
          : { kind: "workspace", authority: "user", mutable: true, network: false },
    requestedSpecifier: `${params.skillName}:${params.installId}`,
    skillName: params.skillName,
    sourceDir: path.resolve(entry.skill.baseDir),
  });
  if (scanResult?.blocked) {
    return withWarnings(
      {
        ok: false,
        message: scanResult.blocked.reason,
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }
  // Warn when install is triggered from a non-bundled source.
  // Workspace/project/personal agent skills can contain attacker-controlled metadata.
  const trustedInstallSources = new Set(["openclaw-bundled", "openclaw-managed", "openclaw-extra"]);
  if (!trustedInstallSources.has(skillSource)) {
    warnings.push(
      `WARNING: Skill "${params.skillName}" install triggered from non-bundled source "${skillSource}". Verify the install recipe is trusted.`,
    );
  }
  if (!spec) {
    return withWarnings(
      {
        ok: false,
        message: `Installer not found: ${params.installId}`,
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }
  if (spec.kind === "download") {
    const downloadResult = await installDownloadSpec({ entry, spec, timeoutMs });
    return withWarnings(downloadResult, warnings);
  }

  const prefs = deps.resolveSkillsInstallPreferences(params.config);
  const command = buildInstallCommand(spec, prefs);
  if (command.error) {
    return withWarnings(
      {
        ok: false,
        message: command.error,
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }

  const brewExe = deps.hasBinary("brew") ? "brew" : deps.resolveBrewExecutable();
  if (spec.kind === "brew" && !brewExe) {
    return withWarnings(resolveBrewMissingFailure(spec), warnings);
  }

  const uvInstallFailure = await ensureUvInstalled({ spec, brewExe, timeoutMs });
  if (uvInstallFailure) {
    return withWarnings(uvInstallFailure, warnings);
  }

  const goWasAlreadyInstalled = spec.kind === "go" && deps.hasBinary("go");
  const goInstallFailure = await ensureGoInstalled({ spec, brewExe, timeoutMs });
  if (goInstallFailure) {
    return withWarnings(goInstallFailure, warnings);
  }

  const argv = command.argv ? [...command.argv] : null;
  if (spec.kind === "brew" && brewExe && argv?.[0] === "brew") {
    argv[0] = brewExe;
  }

  const envOverrides: NodeJS.ProcessEnv = {};
  let installedGoBin: string | undefined;
  if (spec.kind === "node") {
    Object.assign(envOverrides, await buildNodeInstallEnv(prefs));
  }
  if (spec.kind === "go") {
    const brewBin =
      brewExe && !goWasAlreadyInstalled ? await resolveBrewBinDir(timeoutMs, brewExe) : undefined;
    // Skill dependencies use a restart-stable bin directory without changing
    // the operator's Go configuration.
    installedGoBin = brewBin ?? path.join(os.homedir(), ".local", "bin");
    envOverrides.GOBIN = installedGoBin;
    envOverrides.PATH = appendPathDirectory(process.env.PATH, installedGoBin);
  }
  const env = Object.keys(envOverrides).length > 0 ? envOverrides : undefined;

  const installResult = await executeInstallCommand({ argv, timeoutMs, env });
  if (installResult.ok && installedGoBin && envOverrides.PATH) {
    // Keep the just-installed command discoverable without requiring a gateway restart.
    process.env.PATH = envOverrides.PATH;
  }
  const normalizedResult =
    spec.kind === "go" && !installResult.ok && isGoToolchainPrerequisiteFailure(installResult)
      ? { ...installResult, skipReason: "go" as const }
      : installResult;
  return withWarnings(normalizedResult, warnings);
}

export const testing = {
  resolveDefaultNodeInstallStateDir,
  setDepsForTest(overrides?: Partial<SkillsInstallDeps>): void {
    skillsInstallDeps = {
      ...defaultSkillsInstallDeps,
      ...overrides,
    };
  },
};
