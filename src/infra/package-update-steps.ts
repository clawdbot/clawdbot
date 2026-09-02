// Runs package update move, inventory, and cleanup steps.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { resolveBunGlobalInstallOwner } from "./detect-package-manager.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import { completePendingPackageLifecycle } from "./package-lifecycle.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import { trimLogTail } from "./restart-sentinel.js";
import {
  PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  type PackageUpdateStepAdvisory,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import type { GitRuntimeIdentity } from "./update-git-runtime.js";
import {
  collectInstalledGlobalPackageErrors,
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  globalInstallFallbackArgs,
  listActivePnpmIsolatedGlobalPackages,
  readPackageManagerProbeValue,
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  resolvePnpmIsolatedInstallOwner,
  resolvePnpmGlobalDirFromGlobalRoot,
  resolveNpmLifecyclePolicyGate,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallTarget,
  verifyPackageUpdateRecovery,
  type CommandRunner,
  type NpmGlobalPrefixLayout,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import type { UpdateRecovery } from "./update-recovery.js";

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

type StagedNpmSwapResult =
  | {
      status: "committed";
      step: PackageUpdateStepResult;
      postVerifyStep: PackageUpdateStepResult | null;
    }
  | {
      status: "failed";
      step: PackageUpdateStepResult;
      postVerifyStep: PackageUpdateStepResult | null;
      packageRollbackVerified: boolean;
    };

type PackageUpdateStepsResult = {
  steps: PackageUpdateStepResult[];
  verifiedPackageRoot: string | null;
  afterVersion: string | null;
  failedStep: PackageUpdateStepResult | null;
  recovery: UpdateRecovery;
};

const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"] as const;

async function resolveNpmUpdateLifecyclePolicy(params: {
  installTarget: ResolvedGlobalInstallTarget;
}): Promise<{
  policy: ReturnType<typeof resolveNpmLifecyclePolicyGate>["policy"];
  failedStep: PackageUpdateStepResult | null;
}> {
  const gate = resolveNpmLifecyclePolicyGate(params.installTarget);
  if (!gate.error) {
    return { policy: gate.policy, failedStep: null };
  }
  const argv = [params.installTarget.command, "--version"];
  const version = params.installTarget.npmOwner?.version ?? "";
  return {
    policy: null,
    failedStep: {
      name: "npm lifecycle policy preflight",
      command: argv.join(" "),
      cwd: process.cwd(),
      durationMs: 0,
      exitCode: 1,
      stdoutTail: version || null,
      stderrTail: gate.error,
    },
  };
}

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

  // The CLI major is independent of the global layout (pnpm 12 still uses v11).
  // Ownership is established by the active project, reported root, and bin above.
  return {
    globalBinDir,
    failedStep: null,
  };
}
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

function removePath(targetPath: string): Promise<void> {
  return fs.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 2,
    retryDelay: 100,
  });
}

async function removePathBestEffort(targetPath: string): Promise<boolean> {
  try {
    await removePath(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function pathEntryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
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
  const windowsPath = /^[a-z]:[\\/]/iu.test(sourceCwd) || sourceCwd.startsWith("\\\\");
  const paths = windowsPath ? path.win32 : path;
  const localProtocol = /^(file:|git\+file:|link:)(.*)$/iu.exec(targetSpec);
  if (localProtocol) {
    const protocol = localProtocol[1] ?? "";
    const target = localProtocol[2]?.trim() ?? "";
    const fragmentIndex = protocol.toLowerCase() === "git+file:" ? target.indexOf("#") : -1;
    const targetPath = fragmentIndex >= 0 ? target.slice(0, fragmentIndex) : target;
    const fragment = fragmentIndex >= 0 ? target.slice(fragmentIndex) : "";
    const resolvedTarget =
      targetPath &&
      !/^~[\\/]/u.test(targetPath) &&
      !path.isAbsolute(targetPath) &&
      !path.win32.isAbsolute(targetPath)
        ? paths.resolve(sourceCwd, targetPath)
        : targetPath;
    if (protocol.toLowerCase() === "git+file:") {
      return resolvedTarget === targetPath
        ? spec
        : `${hasAlias ? aliasPrefix : ""}git+${pathToFileURL(resolvedTarget, { windows: windowsPath }).href}${fragment}`;
    }
    return `${aliasPrefix}${protocol}${resolvedTarget}`;
  }
  const isPath =
    /^(?:\.{1,2}|~)(?:[\\/]|$)/u.test(targetSpec) ||
    path.isAbsolute(targetSpec) ||
    path.win32.isAbsolute(targetSpec);
  // Match the updater's explicit archive targets; bare .tar remains a registry name.
  if (
    !isPath &&
    (hasAlias || /[:@]/u.test(targetSpec) || !/\.(?:tgz|tar\.gz)$/iu.test(targetSpec))
  ) {
    return spec;
  }
  const target =
    isPath && !/^\.{1,2}(?:[\\/]|$)/u.test(targetSpec)
      ? targetSpec
      : paths.resolve(sourceCwd, targetSpec);
  // Native pnpm needs a package name; source links must follow atomic file replacements.
  return `${aliasPrefix}${/\.(?:tgz|tar\.gz|tar)$/iu.test(target) ? "file" : "link"}:${target}`;
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
  if (stage) {
    await removePathBestEffort(stage.prefix);
  }
}

async function copyPathEntry(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  await removePath(destination);
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
  await fs.chmod(destination, stat.mode);
}

async function pathEntriesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([
    fs.lstat(left).catch(() => null),
    fs.lstat(right).catch(() => null),
  ]);
  if (!leftStat || !rightStat) {
    return false;
  }
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return (
      leftStat.isSymbolicLink() &&
      rightStat.isSymbolicLink() &&
      (await fs.readlink(left)) === (await fs.readlink(right))
    );
  }
  if (!leftStat.isFile() || !rightStat.isFile()) {
    return false;
  }
  if ((leftStat.mode & 0o777) !== (rightStat.mode & 0o777) || leftStat.size !== rightStat.size) {
    return false;
  }
  const [leftContents, rightContents] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return leftContents.equals(rightContents);
}

async function activateStagedNpmPackageRoot(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isSymbolicLink()) {
    await movePathWithCopyFallback({
      from: source,
      sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
      to: destination,
    });
    return;
  }

  // npm represents global local-directory installs as relative symlinks. Moving
  // one changes its meaning, so activate the same canonical source explicitly.
  const canonicalSource = await fs.realpath(source);
  await fs.symlink(
    canonicalSource,
    destination,
    process.platform === "win32" ? "junction" : undefined,
  );
}

async function swapStagedNpmInstall(params: {
  stage: StagedNpmInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  postVerifyStep?: (packageRoot: string) => Promise<PackageUpdateStepResult | null>;
}): Promise<StagedNpmSwapResult> {
  const startedAt = Date.now();
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
    allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
  });
  const targetPackageRoot = params.installTarget.packageRoot;
  const step = (
    exitCode: number,
    stdoutTail: string | null,
    stderrTail: string | null,
  ): PackageUpdateStepResult => ({
    name: "global install swap",
    command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot ?? "unknown root"}`,
    cwd: targetLayout?.globalRoot ?? params.stage.prefix,
    durationMs: Date.now() - startedAt,
    exitCode,
    stdoutTail,
    stderrTail,
  });
  if (!targetLayout || !targetPackageRoot) {
    return {
      status: "failed",
      step: step(1, null, "cannot resolve npm global prefix layout"),
      postVerifyStep: null,
      packageRollbackVerified: false,
    };
  }

  // Recovery artifacts must survive cleanupGlobalRenameDirs on a later update.
  const backupRoot = path.join(
    targetLayout.globalRoot,
    `.openclaw.package-backup-${process.pid}-${Date.now()}`,
  );
  const discardBackup = async (backupPath: string, label: string): Promise<string | null> => {
    if (await removePathBestEffort(backupPath)) {
      return null;
    }
    const retiredPath = path.join(
      targetLayout.globalRoot,
      path.basename(backupPath).replace(/^\.openclaw\./, ".openclaw-"),
    );
    try {
      // Only obsolete backups enter npm's disposable namespace, after restoration
      // or activation completes. Retirement cannot change the update outcome.
      await fs.rename(backupPath, retiredPath);
      return `preserved ${label} at ${retiredPath} for delayed cleanup`;
    } catch {
      return `preserved ${label} at ${backupPath}; remove it manually after verifying the installation`;
    }
  };
  let shimBackupDir: string | undefined;
  let hadPackage = false;
  let previousVersion: string | null = null;
  const shims: Array<{ source: string; destination: string; backup: string | null }> = [];
  const rollback: Array<() => Promise<void>> = [];
  let packageRollbackVerified = false;
  const restoreSwap = async (): Promise<string[]> => {
    const messages: string[] = [];
    for (const restore of rollback.toReversed()) {
      try {
        await restore();
      } catch (restoreError) {
        packageRollbackVerified = false;
        messages.push(`rollback failed: ${formatErrorMessage(restoreError)}`);
      }
    }
    try {
      const restoredVersion = await readPackageVersionIfPresent(targetPackageRoot);
      if (!hadPackage || !previousVersion || restoredVersion !== previousVersion) {
        packageRollbackVerified = false;
        messages.push(
          `rollback verification failed: expected package version ${previousVersion ?? "<none>"}, found ${restoredVersion ?? "<none>"}`,
        );
      }
    } catch (verificationError) {
      packageRollbackVerified = false;
      messages.push(`rollback verification failed: ${formatErrorMessage(verificationError)}`);
    }
    for (const shim of shims) {
      try {
        const restored = shim.backup
          ? await pathEntriesMatch(shim.backup, shim.destination)
          : !(await pathEntryExists(shim.destination));
        if (!restored) {
          packageRollbackVerified = false;
          messages.push(
            `rollback verification failed: launcher ${shim.destination} was not restored`,
          );
        }
      } catch (verificationError) {
        packageRollbackVerified = false;
        messages.push(
          `rollback verification failed for launcher ${shim.destination}: ${formatErrorMessage(verificationError)}`,
        );
      }
    }
    if (!packageRollbackVerified) {
      messages.push(
        `Installation recovery is unverified; inspect the installation and backups in ${targetLayout.globalRoot} before restarting.`,
      );
    } else if (shimBackupDir) {
      const cleanup = await discardBackup(shimBackupDir, "shim backup");
      if (cleanup) {
        messages.push(cleanup);
      }
    }
    return messages;
  };
  try {
    hadPackage = await pathEntryExists(targetPackageRoot);
    previousVersion = hadPackage ? await readPackageVersionIfPresent(targetPackageRoot) : null;
    packageRollbackVerified = hadPackage && previousVersion !== null;
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    const shimNames = new Set([params.packageName, "openclaw"]);
    const shimEntries =
      params.installTarget.directNodeModulesRoot === true
        ? []
        : (
            await fs.readdir(params.stage.layout.binDir).catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return [];
              }
              throw error;
            })
          )
            .filter((entry) => shimNames.has(entry) || shimNames.has(path.parse(entry).name))
            .toSorted();
    if (shimEntries.length > 0) {
      shimBackupDir = await fs.mkdtemp(
        path.join(targetLayout.globalRoot, ".openclaw.shim-backup-"),
      );
      await fs.mkdir(targetLayout.binDir, { recursive: true });
      // Capture every original before moving its package; relative npm shims can
      // become dangling during the swap, and failed backup copies touch no live entry.
      for (const entry of shimEntries) {
        const destination = path.join(targetLayout.binDir, entry);
        const backup = (await pathEntryExists(destination))
          ? path.join(shimBackupDir, entry)
          : null;
        if (backup) {
          await copyPathEntry(destination, backup);
        }
        shims.push({ source: path.join(params.stage.layout.binDir, entry), destination, backup });
      }
    }
    // A copy-fallback move can reject after committing its destination and
    // partially removing its source. Only a completed backup permits restoration.
    packageRollbackVerified = false;
    if (hadPackage) {
      await movePathWithCopyFallback({
        from: targetPackageRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: backupRoot,
      });
      packageRollbackVerified = true;
    }
    rollback.push(async () => {
      await removePath(targetPackageRoot);
      if (hadPackage) {
        await movePathWithCopyFallback({
          from: backupRoot,
          sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
          to: targetPackageRoot,
        });
      }
    });
    await activateStagedNpmPackageRoot(params.stage.packageRoot, targetPackageRoot);
    for (const shim of shims) {
      // Register before copying: replacing an entry can fail after removing it.
      rollback.push(async () => {
        if (shim.backup) {
          await copyPathEntry(shim.backup, shim.destination);
        } else {
          await removePath(shim.destination);
        }
      });
      await copyPathEntry(shim.source, shim.destination);
    }
    let postVerifyStep: PackageUpdateStepResult | null = null;
    if (params.postVerifyStep) {
      try {
        postVerifyStep = await params.postVerifyStep(targetPackageRoot);
      } catch (error) {
        postVerifyStep = {
          name: "post-install verification",
          command: "verify installed package",
          cwd: targetPackageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: formatErrorMessage(error),
        };
      }
      postVerifyStep ??= {
        name: "post-install verification",
        command: "verify installed package",
        cwd: targetPackageRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail:
          "Required post-install verification did not produce a result; Gateway activation is unsafe.",
      };
    }
    if (postVerifyStep && isBlockingPackageUpdateStep(postVerifyStep)) {
      const rollbackMessages = await restoreSwap();
      return {
        status: "failed",
        step: packageRollbackVerified
          ? step(
              0,
              [
                `restored previous ${params.packageName} package and affected launchers after verification failed`,
                "candidate Doctor may have changed persistent state; managed Gateway remains stopped",
                ...rollbackMessages,
              ]
                .filter(Boolean)
                .join("; "),
              null,
            )
          : step(1, null, rollbackMessages.join("\n")),
        postVerifyStep,
        packageRollbackVerified,
      };
    }
    const cleanup = [
      hadPackage ? await discardBackup(backupRoot, "old package") : null,
      shimBackupDir ? await discardBackup(shimBackupDir, "shim backup") : null,
    ];
    return {
      status: "committed",
      step: step(
        0,
        [
          hadPackage ? `replaced ${params.packageName}` : `installed ${params.packageName}`,
          ...cleanup,
        ]
          .filter(Boolean)
          .join("; "),
        null,
      ),
      postVerifyStep,
    };
  } catch (error) {
    const errors = [formatErrorMessage(error), ...(await restoreSwap())];
    return {
      status: "failed",
      step: step(1, null, errors.join("\n")),
      postVerifyStep: null,
      packageRollbackVerified,
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
  expectedGitCheckout?: GitRuntimeIdentity;
}): Promise<PackageUpdateStepsResult> {
  let stagedInstall: StagedNpmInstall | null = null;
  let packedInstallDir: string | null = null;
  let verifiedPackageRoot = params.installTarget.packageRoot ?? params.packageRoot ?? null;
  let afterVersion: string | null = null;
  // Exposing a prepared Git checkout follows its Doctor pass; the old global
  // package cannot be authorized against state that candidate may have migrated.
  let recovery: UpdateRecovery = params.expectedGitCheckout
    ? { serviceRestartSafe: false, reason: "state-migration-started" }
    : await verifyPackageUpdateRecovery(verifiedPackageRoot);
  const steps: PackageUpdateStepResult[] = [];
  const packageUpdateFailure = (
    failedStep: PackageUpdateStepResult,
    failureRoot: string | null,
    failedSteps = [failedStep],
  ): PackageUpdateStepsResult => ({
    steps: failedSteps,
    verifiedPackageRoot: failureRoot,
    afterVersion,
    failedStep,
    recovery,
  });

  try {
    const npmPreflight = await resolveNpmUpdateLifecyclePolicy({
      installTarget: params.installTarget,
    });
    if (npmPreflight.failedStep) {
      return packageUpdateFailure(
        npmPreflight.failedStep,
        params.packageRoot ?? params.installTarget.packageRoot,
      );
    }
    const pnpmPreflight = await validatePnpmIsolatedUpdate({
      installTarget: params.installTarget,
      packageName: params.packageName,
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
    if (pnpmPreflight.failedStep) {
      return packageUpdateFailure(
        pnpmPreflight.failedStep,
        params.packageRoot ?? params.installTarget.packageRoot,
      );
    }
    const packageRoot = params.packageRoot ?? params.installTarget.packageRoot;
    if (packageRoot) {
      // Lifecycle policy must refuse before cleanup can remove an interrupted update backup.
      await cleanupGlobalRenameDirs({
        globalRoot: path.dirname(packageRoot),
        packageName: params.packageName,
      });
    }
    const bunOwner =
      params.installTarget.manager === "bun"
        ? resolveBunGlobalInstallOwner(
            params.installTarget.packageRoot ?? params.packageRoot,
            params.env ?? process.env,
          )
        : null;
    // Bun's global project follows its environment, not the selected binary.
    // Bind the mutation to the verified owner even when service settings drift.
    let effectiveInstallEnv =
      params.installTarget.manager === "bun" && params.installTarget.globalRoot
        ? {
            ...(params.env ?? process.env),
            BUN_INSTALL_GLOBAL_DIR: path.dirname(params.installTarget.globalRoot),
            ...(bunOwner?.bunInstall ? { BUN_INSTALL: bunOwner.bunInstall } : {}),
          }
        : params.env;
    if (params.installTarget.manager === "pnpm" && params.installTarget.globalRoot) {
      const globalDir = resolvePnpmGlobalDirFromGlobalRoot(params.installTarget.globalRoot);
      // Bind verified paths through both pnpm configuration dialects, in both
      // cases, after original-env probes so inherited aliases cannot redirect it.
      // pnpm 11 keeps its already-probed config and cwd.
      effectiveInstallEnv = {
        ...(params.env ?? process.env),
        ...(globalDir
          ? {
              pnpm_config_global_dir: globalDir,
              PNPM_CONFIG_GLOBAL_DIR: globalDir,
              npm_config_global_dir: globalDir,
              NPM_CONFIG_GLOBAL_DIR: globalDir,
            }
          : {}),
        ...(pnpmPreflight.globalBinDir
          ? {
              pnpm_config_global_bin_dir: pnpmPreflight.globalBinDir,
              PNPM_CONFIG_GLOBAL_BIN_DIR: pnpmPreflight.globalBinDir,
              npm_config_global_bin_dir: pnpmPreflight.globalBinDir,
              NPM_CONFIG_GLOBAL_BIN_DIR: pnpmPreflight.globalBinDir,
            }
          : {}),
      };
    }
    const installEnv = effectiveInstallEnv === undefined ? {} : { env: effectiveInstallEnv };
    const preparedInstall = await prepareStagedNpmInstall(params.installTarget, params.packageName);
    stagedInstall = preparedInstall.stagedInstall;
    if (preparedInstall.failedStep) {
      return packageUpdateFailure(preparedInstall.failedStep, params.packageRoot ?? null, [
        preparedInstall.failedStep,
      ]);
    }

    const installCommandTarget = stagedInstall?.installTarget ?? params.installTarget;
    // Package lifecycle hooks can mutate operator state even in a staging prefix.
    // Only completed candidate verification/Doctor may authorize activation afterward.
    recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
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
      return packageUpdateFailure(preparedSpec.failedStep, params.packageRoot ?? null, steps);
    }

    // pnpm selects its version from cwd. Keep every pnpm mutation beside its
    // detected global root, after preserving caller-relative package specs.
    const pnpmMutationCwd =
      installCommandTarget.manager === "pnpm" ? installCommandTarget.globalRoot : null;
    const updateCwd = pnpmMutationCwd ?? preparedSpec.installCwd;
    const updateInstallSpec =
      installCommandTarget.manager === "pnpm"
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
        stagedInstall?.prefix,
        preparedSpec.installCwd,
        npmPreflight.policy ?? undefined,
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
        return packageUpdateFailure(
          preparedFallbackInstall.failedStep,
          params.packageRoot ?? null,
          steps,
        );
      }

      const fallbackArgv = globalInstallFallbackArgs(
        stagedInstall?.installTarget ?? params.installTarget,
        preparedSpec.installSpec,
        undefined,
        stagedInstall?.prefix,
        preparedSpec.installCwd,
        npmPreflight.policy ?? undefined,
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
      return packageUpdateFailure(replacementStep, params.packageRoot ?? null, steps);
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
    verifiedPackageRoot = livePackageRoot ?? verificationPackageRoot;
    if (finalInstallStep.exitCode === 0 && !verificationPackageRoot) {
      const failedStep: PackageUpdateStepResult = {
        name: "global install verify",
        command: "resolve installed package",
        cwd: updateCwd ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stderrTail: "could not identify the installed package root",
      };
      return packageUpdateFailure(failedStep, null, [...steps, failedStep]);
    }

    if (finalInstallStep.exitCode === 0 && verificationPackageRoot) {
      const candidateVersion = await readPackageVersion(verificationPackageRoot);
      if (!stagedInstall) {
        afterVersion = candidateVersion;
      }
      const expectedVersion = resolveExpectedInstalledVersionFromSpec(
        params.packageName,
        params.installSpec,
      );
      let verificationErrors = await collectInstalledGlobalPackageErrors({
        packageRoot: verificationPackageRoot,
        expectedVersion,
        expectedGitCheckout: params.expectedGitCheckout,
      });
      // v2026.8.1 alone shipped this pending marker inside the closed dist inventory.
      const blockingVerificationErrors = verificationErrors.filter(
        (error) =>
          params.installSpec !== "openclaw@2026.8.1" ||
          error !== `unexpected packaged dist file ${LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`,
      );
      if (blockingVerificationErrors.length === 0) {
        let failedLifecycleStep: PackageUpdateStepResult | null = null;
        try {
          const completedLifecycle = await completePendingPackageLifecycle({
            packageRoot: verificationPackageRoot,
            timeoutMs: params.timeoutMs,
            runScript: async (script) => {
              const lifecycleStep = await params.runStep({
                name: `${params.installTarget.manager} package ${script.name}`,
                argv: [process.execPath, path.join(verificationPackageRoot, script.relativePath)],
                cwd: verificationPackageRoot,
                env: effectiveInstallEnv,
                timeoutMs: params.timeoutMs,
              });
              steps.push(lifecycleStep);
              if (lifecycleStep.exitCode !== 0) {
                failedLifecycleStep = lifecycleStep;
                throw new Error(lifecycleStep.stderrTail ?? `${lifecycleStep.name} failed`);
              }
            },
          });
          if (completedLifecycle) {
            verificationErrors = await collectInstalledGlobalPackageErrors({
              packageRoot: verificationPackageRoot,
              expectedVersion,
              expectedGitCheckout: params.expectedGitCheckout,
            });
          }
        } catch (error) {
          if (failedLifecycleStep) {
            return packageUpdateFailure(failedLifecycleStep, verifiedPackageRoot, steps);
          }
          const lifecycleStep: PackageUpdateStepResult = {
            name: `${params.installTarget.manager} package lifecycle`,
            command: `complete ${verificationPackageRoot}`,
            cwd: verificationPackageRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: formatErrorMessage(error),
          };
          steps.push(lifecycleStep);
          return packageUpdateFailure(lifecycleStep, verifiedPackageRoot, steps);
        }
      }
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
      let failedVerification = verificationErrors.length > 0;
      let postVerifyStep: PackageUpdateStepResult | null = null;
      if (stagedInstall && verificationErrors.length === 0) {
        const swap = await swapStagedNpmInstall({
          stage: stagedInstall,
          installTarget: params.installTarget,
          packageName: params.packageName,
          postVerifyStep: params.postVerifyStep,
        });
        steps.push(swap.step);
        if (swap.postVerifyStep) {
          steps.push(swap.postVerifyStep);
        }
        failedVerification = swap.status === "failed";
        postVerifyStep = swap.postVerifyStep;
        // Verified rollback restores package files, not state changed by hooks.
        if (swap.status === "committed") {
          verifiedPackageRoot = params.installTarget.packageRoot ?? verifiedPackageRoot;
          afterVersion = candidateVersion;
        } else {
          recovery = {
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            packageRollbackVerified: swap.packageRollbackVerified,
          };
          afterVersion = await readPackageVersionIfPresent(livePackageRoot);
        }
      }

      if (!stagedInstall && !failedVerification) {
        postVerifyStep = verifiedPackageRoot
          ? ((await params.postVerifyStep?.(verifiedPackageRoot)) ?? null)
          : null;
        if (postVerifyStep) {
          steps.push(postVerifyStep);
        } else if (params.postVerifyStep) {
          steps.push({
            name: "post-install verification",
            command: "verify installed package",
            cwd: verifiedPackageRoot ?? process.cwd(),
            durationMs: 0,
            exitCode: 1,
            stderrTail:
              "Required post-install verification did not produce a result; Gateway activation is unsafe.",
          });
        }
      }
      if (
        !failedVerification &&
        (!params.postVerifyStep ||
          (postVerifyStep && !isBlockingPackageUpdateStep(postVerifyStep))) &&
        candidateVersion
      ) {
        recovery = { serviceRestartSafe: true, version: candidateVersion };
      }
      if (failedVerification && stagedInstall) {
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
      recovery,
    };
  } catch (error) {
    const failedStep: PackageUpdateStepResult = {
      name: "package update",
      command: "update installed package",
      cwd: verifiedPackageRoot ?? params.installCwd ?? process.cwd(),

      durationMs: 0,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
    };
    return packageUpdateFailure(failedStep, verifiedPackageRoot, [...steps, failedStep]);
  } finally {
    await cleanupStagedNpmInstall(stagedInstall);
    if (packedInstallDir) {
      await removePathBestEffort(packedInstallDir);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
