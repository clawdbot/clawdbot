// Runs package update move, inventory, and cleanup steps.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "./errors.js";
import { pathExists } from "./fs-safe.js";
import { readPackageVersion } from "./package-json.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import { trimLogTail } from "./restart-sentinel.js";
import { parseSemver } from "./runtime-guard.js";
import {
  PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  type PackageUpdateStepAdvisory,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
export type { PackageUpdateStepAdvisory } from "./update-doctor-result.js";
import {
  collectInstalledGlobalPackageErrors,
  globalInstallArgs,
  globalInstallFallbackArgs,
  listActivePnpmIsolatedGlobalPackages,
  readPackageManagerProbeValue,
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  resolvePnpmIsolatedInstallOwner,
  resolvePnpmGlobalDirFromGlobalRoot,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallTarget,
  type CommandRunner,
  type NpmGlobalPrefixLayout,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;

/**
 * Captures one package-manager or filesystem step from the global update flow.
 * Callers surface these records directly in update diagnostics.
 */
type PackageUpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
  advisory?: PackageUpdateStepAdvisory;
};

type PackageUpdateStepRunner = (params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<PackageUpdateStepResult>;

type StagedNpmInstall = {
  prefix: string;
  layout: NpmGlobalPrefixLayout;
  packageRoot: string;
  installTarget: ResolvedGlobalInstallTarget;
};

type NpmBinShimBackup = {
  backupDir: string;
  targetBinDir: string;
  entries: Array<{
    name: string;
    hadExisting: boolean;
  }>;
};

const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"] as const;
const PACKAGE_INSTALL_GUARD_PATH = path.join("dist", "openclaw-install-guard");
const PACKAGE_LIFECYCLE_PENDING_PATH = ".openclaw-lifecycle-pending";
const PACKAGE_PREINSTALL_SCRIPT_PATH = path.join(
  "scripts",
  "preinstall-package-manager-warning.mjs",
);

async function resolveCanonicalPath(filePath: string): Promise<string> {
  return path.resolve(await fs.realpath(filePath).catch(() => filePath));
}

async function runPnpmPreflightProbe(params: {
  installTarget: ResolvedGlobalInstallTarget;
  args: string[];
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  result: Awaited<ReturnType<CommandRunner>> | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const startedAt = Date.now();
  const argv = [params.installTarget.command, ...params.args];
  const probeCwd = params.installTarget.globalRoot ?? undefined;
  try {
    // pnpm reads project packageManager/config for every command. Keep all
    // ownership probes in one manager-owned context before mutation.
    const result = await params.runCommand(argv, {
      timeoutMs: params.timeoutMs,
      env: params.env,
      ...(probeCwd ? { cwd: probeCwd } : {}),
    });
    if (result.code === 0) {
      return { result, failedStep: null };
    }
    return {
      result: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: argv.join(" "),
        cwd: probeCwd ?? process.cwd(),
        durationMs: Date.now() - startedAt,
        exitCode: result.code ?? 1,
        stdoutTail: result.stdout || null,
        stderrTail: result.stderr || `Unable to run ${argv.join(" ")}.`,
      },
    };
  } catch (error) {
    return {
      result: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: argv.join(" "),
        cwd: probeCwd ?? process.cwd(),
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatErrorMessage(error),
      },
    };
  }
}

async function validatePnpmIsolatedUpdate(params: {
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  globalBinDir: string | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const owner = params.installTarget.pnpmIsolated;
  if (!owner) {
    return { globalBinDir: null, failedStep: null };
  }
  const activePackages = await listActivePnpmIsolatedGlobalPackages({
    globalRoot: params.installTarget.globalRoot,
    packageName: params.packageName,
  });
  const activePackageRoots = activePackages.map((entry) => entry.packageRoot);
  const siblingPackages = [
    ...new Set(
      activePackages.flatMap((entry) =>
        entry.packageNames.filter((name) => name !== params.packageName),
      ),
    ),
  ].toSorted((a, b) => a.localeCompare(b));
  if (siblingPackages.length > 0) {
    return {
      globalBinDir: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: `inspect ${params.installTarget.globalRoot ?? "pnpm install"}`,
        cwd: params.installTarget.globalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: `OpenClaw shares a pnpm ${owner.layoutVersion} global install group with ${siblingPackages.join(", ")}. Automatic update stopped before mutation; update the group manually to preserve its sibling packages.`,
      },
    };
  }

  const invokingPackageRoot = params.installTarget.packageRoot;
  const invokingInstallOwner = await resolvePnpmIsolatedInstallOwner(invokingPackageRoot);
  const activeInstallOwners = await Promise.all(
    activePackageRoots.map((packageRoot) => resolvePnpmIsolatedInstallOwner(packageRoot)),
  );
  const ownerMatchCount = invokingInstallOwner
    ? activeInstallOwners.filter((installOwner) => installOwner === invokingInstallOwner).length
    : 0;
  if (!invokingPackageRoot || activePackageRoots.length !== 1 || ownerMatchCount !== 1) {
    return {
      globalBinDir: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: `inspect ${params.installTarget.globalRoot ?? "pnpm install"}`,
        cwd: params.installTarget.globalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: `Expected exactly one active pnpm ${owner.layoutVersion} OpenClaw install owned by the invoking project; found ${activePackageRoots.length} active installs and ${ownerMatchCount} owner matches. Automatic update stopped before mutation.`,
      },
    };
  }

  const rootProbe = await runPnpmPreflightProbe({ ...params, args: ["root", "-g"] });
  if (rootProbe.failedStep || !rootProbe.result) {
    return {
      globalBinDir: null,
      failedStep: rootProbe.failedStep,
    };
  }
  const reportedGlobalRoot = readPackageManagerProbeValue(rootProbe.result.stdout);
  const expectedGlobalRoot = params.installTarget.globalRoot;
  if (
    !reportedGlobalRoot ||
    !expectedGlobalRoot ||
    (await resolveCanonicalPath(reportedGlobalRoot)) !==
      (await resolveCanonicalPath(expectedGlobalRoot))
  ) {
    return {
      globalBinDir: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: `${params.installTarget.command} root -g`,
        cwd: expectedGlobalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stdoutTail: rootProbe.result.stdout || null,
        stderrTail: `The active pnpm command owns ${reportedGlobalRoot || "an unknown global root"}, not the invoking OpenClaw install at ${expectedGlobalRoot ?? "an unknown root"}. Automatic update stopped before mutation.`,
      },
    };
  }

  const binProbe = await runPnpmPreflightProbe({ ...params, args: ["bin", "-g"] });
  const globalBinDir = binProbe.result
    ? readPackageManagerProbeValue(binProbe.result.stdout) || null
    : null;
  if (binProbe.failedStep || !globalBinDir) {
    return {
      globalBinDir: null,
      failedStep: binProbe.failedStep ?? {
        name: "pnpm isolated install preflight",
        command: `${params.installTarget.command} bin -g`,
        cwd: expectedGlobalRoot,
        durationMs: 0,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: "The owning pnpm command did not report its global bin directory.",
      },
    };
  }

  const versionProbe = await runPnpmPreflightProbe({ ...params, args: ["--version"] });
  if (versionProbe.failedStep || !versionProbe.result) {
    return {
      globalBinDir: null,
      failedStep: versionProbe.failedStep,
    };
  }
  const reportedVersion = readPackageManagerProbeValue(versionProbe.result.stdout);
  const version = parseSemver(reportedVersion);
  if (version?.major !== owner.layoutVersion) {
    return {
      globalBinDir: null,
      failedStep: {
        name: "pnpm isolated install preflight",
        command: `${params.installTarget.command} --version`,
        cwd: expectedGlobalRoot,
        durationMs: 0,
        exitCode: 1,
        stdoutTail: versionProbe.result.stdout || null,
        stderrTail: `OpenClaw belongs to pnpm isolated layout v${owner.layoutVersion}, but the update command reports pnpm ${reportedVersion || "unknown"}. Use pnpm ${owner.layoutVersion} for this install or update it manually.`,
      },
    };
  }

  return {
    globalBinDir,
    failedStep: null,
  };
}
const PACKAGE_POSTINSTALL_SCRIPT_PATH = path.join("scripts", "postinstall-bundled-plugins.mjs");

function isBlockingPackageUpdateStep(step: PackageUpdateStepResult): boolean {
  return step.exitCode !== 0 && step.advisory === undefined;
}

function isNormalProcessExit(step: {
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}): boolean {
  return (
    step.termination !== "timeout" &&
    step.termination !== "no-output-timeout" &&
    step.termination !== "signal" &&
    step.killed !== true &&
    (step.signal === undefined || step.signal === null)
  );
}

export function markPackagePostInstallDoctorAdvisory<
  T extends {
    exitCode: number | null;
    stderrTail?: string | null;
    signal?: NodeJS.Signals | null;
    killed?: boolean;
    termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
    advisory?: PackageUpdateStepAdvisory;
  },
>(
  step: T,
  result: UpdatePostInstallDoctorResult | null,
): T & {
  advisory?: PackageUpdateStepAdvisory;
} {
  if (
    step.exitCode !== UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE ||
    result?.status !== "advisory" ||
    !isNormalProcessExit(step)
  ) {
    return step;
  }
  const advisoryTail = [
    step.stderrTail,
    ...result.advisory.details,
    PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
  ]
    .filter((line): line is string => Boolean(line?.trim()))
    .join("\n");
  return {
    ...step,
    advisory: PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
    stderrTail: trimLogTail(advisoryTail) ?? step.stderrTail,
  };
}

async function removePathBestEffort(targetPath: string): Promise<boolean> {
  try {
    await fs.rm(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 2,
      retryDelay: 100,
    });
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersionIfPresent(packageRoot: string | null): Promise<string | null> {
  if (!packageRoot) {
    return null;
  }
  try {
    return await readPackageVersion(packageRoot);
  } catch {
    return null;
  }
}

function isUnambiguousNpmPrefixGlobalRoot(globalRoot: string | null): boolean {
  const trimmed = globalRoot?.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = path.resolve(trimmed);
  if (path.basename(normalized) !== "node_modules") {
    return false;
  }
  const parentDir = path.dirname(normalized);
  if (path.basename(parentDir) === "lib") {
    return true;
  }
  return process.platform === "win32" && path.basename(parentDir).toLowerCase() === "npm";
}

function resolveStagedNpmTargetLayout(
  installTarget: ResolvedGlobalInstallTarget,
): NpmGlobalPrefixLayout | null {
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, {
    allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true,
  });
  if (!targetLayout) {
    return null;
  }
  if (
    installTarget.manager === "npm" ||
    isUnambiguousNpmPrefixGlobalRoot(installTarget.globalRoot)
  ) {
    return targetLayout;
  }
  return null;
}

function stripPackageAlias(spec: string, packageName: string): string {
  const trimmed = spec.trim();
  const prefix = `${packageName.trim()}@`;
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length).trim()
    : trimmed;
}

function isHttpGitUrlSpec(spec: string): boolean {
  try {
    const url = new URL(spec);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.endsWith(".git")) {
      return true;
    }
    const parts = pathname.split("/").filter(Boolean);
    return url.hostname.toLowerCase() === "github.com" && parts.length === 2;
  } catch {
    return false;
  }
}

function isGitHubShorthandSpec(spec: string): boolean {
  const [repo] = spec.split("#", 1);
  if (!repo || repo.startsWith(".") || repo.startsWith("/") || repo.startsWith("@")) {
    return false;
  }
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => /^[^\s/:@]+$/u.test(part));
}

function isNpmGitSourceInstallSpec(spec: string, packageName: string): boolean {
  const target = stripPackageAlias(spec, packageName);
  return (
    /^github:/i.test(target) ||
    /^git\+(?:ssh|https|http|file):/i.test(target) ||
    /^git:/i.test(target) ||
    /^ssh:\/\//i.test(target) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target) ||
    isHttpGitUrlSpec(target) ||
    isGitHubShorthandSpec(target)
  );
}

function resolvePnpmInstallSpecFromCwd(
  spec: string,
  packageName: string,
  sourceCwd: string,
): string {
  const trimmed = spec.trim();
  const aliasPrefix = `${packageName.trim()}@`;
  const hasAlias = trimmed.toLowerCase().startsWith(aliasPrefix.toLowerCase());
  const targetSpec = hasAlias ? trimmed.slice(aliasPrefix.length).trim() : trimmed;
  const restoreAlias = (target: string) => (hasAlias ? `${aliasPrefix}${target}` : target);
  if (/^~[\\/]/u.test(targetSpec)) {
    return spec;
  }
  const localProtocol = /^(file:|git\+file:|link:)(.*)$/iu.exec(targetSpec);
  if (localProtocol) {
    const protocol = localProtocol[1] ?? "";
    const target = localProtocol[2]?.trim() ?? "";
    const fragmentIndex = protocol.toLowerCase() === "git+file:" ? target.indexOf("#") : -1;
    const targetPath = fragmentIndex >= 0 ? target.slice(0, fragmentIndex) : target;
    const fragment = fragmentIndex >= 0 ? target.slice(fragmentIndex) : "";
    if (
      targetPath &&
      !/^~[\\/]/u.test(targetPath) &&
      !path.isAbsolute(targetPath) &&
      !path.win32.isAbsolute(targetPath)
    ) {
      const windowsPath = /^[a-z]:[\\/]/iu.test(sourceCwd) || sourceCwd.startsWith("\\\\");
      const resolvedTarget = (windowsPath ? path.win32 : path).resolve(sourceCwd, targetPath);
      if (protocol.toLowerCase() === "git+file:") {
        return restoreAlias(
          `git+${pathToFileURL(resolvedTarget, { windows: windowsPath }).href}${fragment}`,
        );
      }
      return restoreAlias(`${protocol}${resolvedTarget}`);
    }
    return spec;
  }
  // pnpm treats scheme-less tar-like values as registry names or tags. Only
  // explicit dot paths are caller-relative and must move with the command cwd.
  const isRelativePath = /^\.{1,2}(?:[\\/]|$)/u.test(targetSpec);
  return isRelativePath ? restoreAlias(path.resolve(sourceCwd, targetSpec)) : spec;
}

async function createStagedNpmInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<StagedNpmInstall | null> {
  const targetLayout = resolveStagedNpmTargetLayout(installTarget);
  if (!targetLayout) {
    return null;
  }
  await fs.mkdir(targetLayout.globalRoot, { recursive: true });
  const prefix = await fs.mkdtemp(path.join(targetLayout.globalRoot, ".openclaw-update-stage-"));
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  const command = installTarget.manager === "npm" ? installTarget.command : "npm";
  return {
    prefix,
    layout,
    packageRoot: path.join(layout.globalRoot, packageName),
    installTarget: {
      manager: "npm",
      command,
      globalRoot: layout.globalRoot,
      packageRoot: path.join(layout.globalRoot, packageName),
    },
  };
}

async function findPackedTarball(packDir: string): Promise<string | null> {
  const entries = await fs.readdir(packDir).catch((): string[] => []);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    return null;
  }
  return path.join(packDir, tarballs[0] ?? "");
}

async function prepareNpmGitSourceInstallSpec(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
}): Promise<{
  installSpec: string;
  installCwd: string | null;
  packDir: string | null;
  steps: PackageUpdateStepResult[];
  failedStep: PackageUpdateStepResult | null;
}> {
  if (
    params.installTarget.manager !== "npm" ||
    !isNpmGitSourceInstallSpec(params.installSpec, params.packageName)
  ) {
    return {
      installSpec: params.installSpec,
      installCwd: params.installCwd ?? null,
      packDir: null,
      steps: [],
      failedStep: null,
    };
  }

  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pack-"));
  const packStep = await params.runStep({
    name: "global update pack",
    argv: [
      params.installTarget.command,
      "pack",
      params.installSpec,
      "--pack-destination",
      packDir,
      ...NPM_PACK_QUIET_FLAGS,
    ],
    cwd: params.installCwd,
    env: params.env,
    timeoutMs: params.timeoutMs,
  });
  if (packStep.exitCode !== 0) {
    return {
      installSpec: params.installSpec,
      installCwd: params.installCwd ?? null,
      packDir,
      steps: [packStep],
      failedStep: packStep,
    };
  }

  const tarball = await findPackedTarball(packDir);
  if (!tarball) {
    const failedStep: PackageUpdateStepResult = {
      name: "global update pack verify",
      command: `find packed tarball in ${packDir}`,
      cwd: packDir,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: `expected exactly one .tgz from npm pack ${params.installSpec}`,
    };
    return {
      installSpec: params.installSpec,
      installCwd: params.installCwd ?? null,
      packDir,
      steps: [packStep, failedStep],
      failedStep,
    };
  }

  return {
    installSpec: tarball,
    installCwd: packDir,
    packDir,
    steps: [packStep],
    failedStep: null,
  };
}

async function prepareStagedNpmInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<{
  stagedInstall: StagedNpmInstall | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const startedAt = Date.now();
  try {
    return {
      stagedInstall: await createStagedNpmInstall(installTarget, packageName),
      failedStep: null,
    };
  } catch (err) {
    const targetLayout =
      installTarget.manager === "npm"
        ? resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, {
            allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true,
          })
        : null;
    return {
      stagedInstall: null,
      failedStep: {
        name: "global install stage",
        command: "prepare staged npm install",
        cwd: targetLayout?.prefix ?? installTarget.globalRoot ?? process.cwd(),
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatErrorMessage(err),
      },
    };
  }
}

async function cleanupStagedNpmInstall(stage: StagedNpmInstall | null): Promise<void> {
  if (!stage) {
    return;
  }
  await removePathBestEffort(stage.prefix);
}

async function copyPathEntry(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  await removePathBestEffort(destination);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      preserveTimestamps: false,
    });
    return;
  }
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode).catch(() => undefined);
}

async function replaceNpmBinShims(params: {
  stageLayout: NpmGlobalPrefixLayout;
  targetLayout: NpmGlobalPrefixLayout;
  packageName: string;
}): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(params.stageLayout.binDir);
  } catch {
    return;
  }

  const names = new Set([params.packageName, "openclaw"]);
  const shimEntries = entries.filter((entry) => {
    const parsed = path.parse(entry);
    return names.has(entry) || names.has(parsed.name);
  });
  if (shimEntries.length === 0) {
    return;
  }

  const backup: NpmBinShimBackup = {
    backupDir: await fs.mkdtemp(
      path.join(params.targetLayout.globalRoot, ".openclaw-shim-backup-"),
    ),
    targetBinDir: params.targetLayout.binDir,
    entries: [],
  };

  try {
    await fs.mkdir(params.targetLayout.binDir, { recursive: true });
    for (const entry of shimEntries) {
      const destination = path.join(params.targetLayout.binDir, entry);
      const hadExisting = await pathExists(destination);
      backup.entries.push({ name: entry, hadExisting });
      if (hadExisting) {
        await copyPathEntry(destination, path.join(backup.backupDir, entry));
      }
    }

    for (const entry of shimEntries) {
      await copyPathEntry(
        path.join(params.stageLayout.binDir, entry),
        path.join(params.targetLayout.binDir, entry),
      );
    }
  } catch (err) {
    await restoreNpmBinShimBackup(backup);
    throw err;
  } finally {
    await removePathBestEffort(backup.backupDir);
  }
}

async function restoreNpmBinShimBackup(backup: NpmBinShimBackup): Promise<void> {
  await fs.mkdir(backup.targetBinDir, { recursive: true });
  for (const entry of backup.entries) {
    const destination = path.join(backup.targetBinDir, entry.name);
    await removePathBestEffort(destination);
    if (entry.hadExisting) {
      await copyPathEntry(path.join(backup.backupDir, entry.name), destination);
    }
  }
}

async function swapStagedNpmInstall(params: {
  stage: StagedNpmInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
}): Promise<PackageUpdateStepResult> {
  const startedAt = Date.now();
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
    allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
  });
  const targetPackageRoot = params.installTarget.packageRoot;
  if (!targetLayout || !targetPackageRoot) {
    return {
      name: "global install swap",
      command: "swap staged npm install",
      cwd: params.stage.prefix,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: "cannot resolve npm global prefix layout",
    };
  }

  const backupRoot = path.join(targetLayout.globalRoot, `.openclaw-${process.pid}-${Date.now()}`);
  let movedExisting = false;
  let movedStaged = false;
  let removedBackup = true;
  try {
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    if (await pathExists(targetPackageRoot)) {
      await movePathWithCopyFallback({
        from: targetPackageRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: backupRoot,
      });
      movedExisting = true;
    }
    await movePathWithCopyFallback({
      from: params.stage.packageRoot,
      sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
      to: targetPackageRoot,
    });
    movedStaged = true;
    if (params.installTarget.directNodeModulesRoot !== true) {
      await replaceNpmBinShims({
        stageLayout: params.stage.layout,
        targetLayout,
        packageName: params.packageName,
      });
    }
    if (movedExisting) {
      removedBackup = await removePathBestEffort(backupRoot);
    }
    return {
      name: "global install swap",
      command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
      cwd: targetLayout.globalRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: movedExisting
        ? removedBackup
          ? `replaced ${params.packageName}`
          : `replaced ${params.packageName}; preserved old package at ${backupRoot} for delayed cleanup`
        : `installed ${params.packageName}`,
      stderrTail: null,
    };
  } catch (err) {
    if (movedStaged) {
      await removePathBestEffort(targetPackageRoot);
    }
    if (movedExisting) {
      await movePathWithCopyFallback({
        from: backupRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: targetPackageRoot,
      }).catch(() => undefined);
    }
    return {
      name: "global install swap",
      command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
      cwd: targetLayout.globalRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: formatErrorMessage(err),
    };
  }
}

/**
 * Runs the global package update flow, including npm staging when possible,
 * package verification, optional post-verification, and cleanup.
 */
export async function runGlobalPackageUpdateSteps(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  packageRoot?: string | null;
  runCommand: CommandRunner;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
  postVerifyStep?: (packageRoot: string) => Promise<PackageUpdateStepResult | null>;
}): Promise<{
  steps: PackageUpdateStepResult[];
  verifiedPackageRoot: string | null;
  afterVersion: string | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  let stagedInstall: StagedNpmInstall | null | undefined;
  let packedInstallDir: string | null = null;

  try {
    const pnpmPreflight = await validatePnpmIsolatedUpdate({
      installTarget: params.installTarget,
      packageName: params.packageName,
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
    if (pnpmPreflight.failedStep) {
      return {
        steps: [pnpmPreflight.failedStep],
        verifiedPackageRoot: params.packageRoot ?? params.installTarget.packageRoot,
        afterVersion: null,
        failedStep: pnpmPreflight.failedStep,
      };
    }
    // Keep the preflight and mutation on the same pnpm executable. `pnpm bin -g`
    // already verifies its reported bin is on PATH, so no PATH rewrite is needed.
    const effectiveInstallEnv = params.env;
    const installEnv = effectiveInstallEnv === undefined ? {} : { env: effectiveInstallEnv };
    const resolvedInstallTarget =
      params.installTarget.pnpmIsolated && pnpmPreflight.globalBinDir
        ? {
            ...params.installTarget,
            pnpmIsolated: {
              ...params.installTarget.pnpmIsolated,
              globalBinDir: pnpmPreflight.globalBinDir,
            },
          }
        : params.installTarget;

    const preparedInstall = await prepareStagedNpmInstall(
      resolvedInstallTarget,
      params.packageName,
    );
    stagedInstall = preparedInstall.stagedInstall;
    if (preparedInstall.failedStep) {
      return {
        steps: [preparedInstall.failedStep],
        verifiedPackageRoot: params.packageRoot ?? null,
        afterVersion: null,
        failedStep: preparedInstall.failedStep,
      };
    }

    const steps: PackageUpdateStepResult[] = [];
    const installCommandTarget = stagedInstall?.installTarget ?? resolvedInstallTarget;
    const preparedSpec = await prepareNpmGitSourceInstallSpec({
      installTarget: installCommandTarget,
      installSpec: params.installSpec,
      packageName: params.packageName,
      runStep: params.runStep,
      timeoutMs: params.timeoutMs,
      env: params.env,
      installCwd: params.installCwd,
    });
    packedInstallDir = preparedSpec.packDir;
    steps.push(...preparedSpec.steps);
    if (preparedSpec.failedStep) {
      return {
        steps,
        verifiedPackageRoot: params.packageRoot ?? null,
        afterVersion: null,
        failedStep: preparedSpec.failedStep,
      };
    }

    const installLocation =
      stagedInstall?.prefix ??
      (installCommandTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installCommandTarget.globalRoot)
        : null);
    // pnpm selects its version from cwd. Keep every pnpm mutation beside its
    // detected global root, after preserving caller-relative package specs.
    const pnpmMutationCwd =
      installCommandTarget.manager === "pnpm" ? installCommandTarget.globalRoot : null;
    const updateCwd = pnpmMutationCwd ?? preparedSpec.installCwd;
    const updateInstallSpec = pnpmMutationCwd
      ? resolvePnpmInstallSpecFromCwd(
          preparedSpec.installSpec,
          params.packageName,
          preparedSpec.installCwd ?? process.cwd(),
        )
      : preparedSpec.installSpec;
    const updateStep = await params.runStep({
      name: "global update",
      argv: globalInstallArgs(
        installCommandTarget,
        updateInstallSpec,
        undefined,
        installLocation,
        preparedSpec.installCwd,
      ),
      ...(updateCwd ? { cwd: updateCwd } : {}),
      ...installEnv,
      timeoutMs: params.timeoutMs,
    });

    steps.push(updateStep);
    let finalInstallStep = updateStep;
    if (updateStep.exitCode !== 0) {
      await cleanupStagedNpmInstall(stagedInstall);
      stagedInstall = null;
      const preparedFallbackInstall = await prepareStagedNpmInstall(
        params.installTarget,
        params.packageName,
      );
      stagedInstall = preparedFallbackInstall.stagedInstall;
      if (preparedFallbackInstall.failedStep) {
        steps.push(preparedFallbackInstall.failedStep);
        return {
          steps,
          verifiedPackageRoot: params.packageRoot ?? null,
          afterVersion: null,
          failedStep: preparedFallbackInstall.failedStep,
        };
      }

      const fallbackArgv = globalInstallFallbackArgs(
        stagedInstall?.installTarget ?? params.installTarget,
        preparedSpec.installSpec,
        undefined,
        stagedInstall?.prefix,
        preparedSpec.installCwd,
      );
      if (fallbackArgv) {
        const fallbackStep = await params.runStep({
          name: "global update (omit optional)",
          argv: fallbackArgv,
          ...(preparedSpec.installCwd ? { cwd: preparedSpec.installCwd } : {}),
          ...installEnv,
          timeoutMs: params.timeoutMs,
        });
        steps.push(fallbackStep);
        finalInstallStep = fallbackStep;
      } else {
        await cleanupStagedNpmInstall(stagedInstall);
        stagedInstall = null;
      }
    }

    // pnpm 11 replaces an isolated global project with a new install directory.
    // Resolve it again before verification so doctor and version checks inspect
    // the package behind the refreshed global shim, not the removed old root.
    const refreshedPnpmPackageRoot =
      finalInstallStep.exitCode === 0 && !stagedInstall && params.installTarget.pnpmIsolated
        ? await (async () => {
            const activeRoots = (
              await listActivePnpmIsolatedGlobalPackages({
                globalRoot: params.installTarget.globalRoot,
                packageName: params.packageName,
              })
            ).map((entry) => entry.packageRoot);
            if (activeRoots.length !== 1 || !params.installTarget.packageRoot) {
              return null;
            }
            const replacementRoot = activeRoots[0];
            if (!replacementRoot) {
              return null;
            }
            const [replacementOwner, previousOwner] = await Promise.all([
              resolvePnpmIsolatedInstallOwner(replacementRoot),
              resolvePnpmIsolatedInstallOwner(params.installTarget.packageRoot),
            ]);
            return replacementOwner && previousOwner && replacementOwner !== previousOwner
              ? replacementRoot
              : null;
          })()
        : null;
    const pnpmReplacementMissing =
      finalInstallStep.exitCode === 0 &&
      !stagedInstall &&
      params.installTarget.manager === "pnpm" &&
      params.installTarget.pnpmIsolated !== undefined &&
      params.installTarget.packageRoot !== null &&
      refreshedPnpmPackageRoot === null;
    if (pnpmReplacementMissing) {
      const replacementStep: PackageUpdateStepResult = {
        name: "global install verify",
        command: `resolve pnpm replacement in ${params.installTarget.globalRoot ?? "unknown root"}`,
        cwd: params.installTarget.globalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stderrTail: "could not identify a unique active pnpm replacement package",
      };
      steps.push(replacementStep);
      return {
        steps,
        verifiedPackageRoot: params.packageRoot ?? null,
        afterVersion: null,
        failedStep: replacementStep,
      };
    }
    const livePackageRoot =
      refreshedPnpmPackageRoot ??
      params.installTarget.packageRoot ??
      params.packageRoot ??
      (
        await resolveGlobalInstallTarget({
          manager: params.installTarget,
          runCommand: params.runCommand,
          timeoutMs: params.timeoutMs,
          packageName: params.packageName,
        })
      ).packageRoot ??
      null;
    const verificationPackageRoot = stagedInstall?.packageRoot ?? livePackageRoot;
    let verifiedPackageRoot = livePackageRoot ?? verificationPackageRoot;

    // Some pnpm releases accept --allow-build for global local-tar installs
    // but still skip lifecycle scripts. Keep a marker outside dist because
    // postinstall prunes the packed guard before the remaining work finishes.
    if (
      finalInstallStep.exitCode === 0 &&
      !stagedInstall &&
      params.installTarget.manager === "pnpm" &&
      verificationPackageRoot
    ) {
      const installGuardPath = path.join(verificationPackageRoot, PACKAGE_INSTALL_GUARD_PATH);
      const lifecyclePendingPath = path.join(
        verificationPackageRoot,
        PACKAGE_LIFECYCLE_PENDING_PATH,
      );
      const hasInstallGuard = await pathExists(installGuardPath);
      const hasPendingLifecycle = await pathExists(lifecyclePendingPath);
      if (hasInstallGuard || hasPendingLifecycle) {
        if (!hasPendingLifecycle) {
          try {
            await fs.writeFile(lifecyclePendingPath, "pending\n", "utf8");
          } catch (error) {
            const markerStep: PackageUpdateStepResult = {
              name: "pnpm package lifecycle marker",
              command: `write ${lifecyclePendingPath}`,
              cwd: verificationPackageRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: formatErrorMessage(error),
            };
            steps.push(markerStep);
            return {
              steps,
              verifiedPackageRoot,
              afterVersion: null,
              failedStep: markerStep,
            };
          }
        }

        const lifecycleScripts = [
          ...(hasInstallGuard
            ? [["pnpm package preinstall", PACKAGE_PREINSTALL_SCRIPT_PATH] as const]
            : []),
          ["pnpm package postinstall", PACKAGE_POSTINSTALL_SCRIPT_PATH] as const,
        ];
        for (const [name, relativeScript] of lifecycleScripts) {
          const lifecycleStep = await params.runStep({
            name,
            argv: [process.execPath, path.join(verificationPackageRoot, relativeScript)],
            cwd: verificationPackageRoot,
            env: effectiveInstallEnv,
            timeoutMs: params.timeoutMs,
          });
          steps.push(lifecycleStep);
          if (lifecycleStep.exitCode !== 0) {
            return {
              steps,
              verifiedPackageRoot,
              afterVersion: null,
              failedStep: lifecycleStep,
            };
          }
        }

        try {
          await fs.rm(lifecyclePendingPath);
        } catch (error) {
          const finalizeStep: PackageUpdateStepResult = {
            name: "pnpm package lifecycle finalize",
            command: `remove ${lifecyclePendingPath}`,
            cwd: verificationPackageRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: formatErrorMessage(error),
          };
          steps.push(finalizeStep);
          return {
            steps,
            verifiedPackageRoot,
            afterVersion: null,
            failedStep: finalizeStep,
          };
        }
      }
    }

    let afterVersion: string | null = null;
    if (finalInstallStep.exitCode === 0 && verificationPackageRoot) {
      const candidateVersion = await readPackageVersion(verificationPackageRoot);
      if (!stagedInstall) {
        afterVersion = candidateVersion;
      }
      const expectedVersion = resolveExpectedInstalledVersionFromSpec(
        params.packageName,
        params.installSpec,
      );
      const verificationErrors = await collectInstalledGlobalPackageErrors({
        packageRoot: verificationPackageRoot,
        expectedVersion,
      });
      if (verificationErrors.length > 0) {
        steps.push({
          name: "global install verify",
          command: `verify ${verificationPackageRoot}`,
          cwd: verificationPackageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: verificationErrors.join("\n"),
          stdoutTail: null,
        });
      }

      if (stagedInstall && verificationErrors.length === 0) {
        const swapStep = await swapStagedNpmInstall({
          stage: stagedInstall,
          installTarget: params.installTarget,
          packageName: params.packageName,
        });
        steps.push(swapStep);
        if (swapStep.exitCode === 0) {
          verifiedPackageRoot = params.installTarget.packageRoot ?? verifiedPackageRoot;
          afterVersion = candidateVersion;
        }
      }

      const failedVerifyOrSwap = steps.find(
        (step) =>
          (step.name === "global install verify" || step.name === "global install swap") &&
          step.exitCode !== 0,
      );
      const postVerifyStep = failedVerifyOrSwap
        ? null
        : verifiedPackageRoot
          ? await params.postVerifyStep?.(verifiedPackageRoot)
          : null;
      if (postVerifyStep) {
        steps.push(postVerifyStep);
      }
      if (failedVerifyOrSwap && stagedInstall) {
        afterVersion = await readPackageVersionIfPresent(livePackageRoot);
      }
    }

    const failedStep = isBlockingPackageUpdateStep(finalInstallStep)
      ? finalInstallStep
      : (steps.find((step) => step !== updateStep && isBlockingPackageUpdateStep(step)) ?? null);

    return {
      steps,
      verifiedPackageRoot,
      afterVersion,
      failedStep,
    };
  } finally {
    await cleanupStagedNpmInstall(stagedInstall ?? null);
    if (packedInstallDir) {
      await removePathBestEffort(packedInstallDir);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
