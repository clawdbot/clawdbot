import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs-safe.js";
import { readPackageVersion } from "./package-json.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import {
  collectInstalledGlobalPackageErrors,
  globalInstallArgs,
  globalInstallFallbackArgs,
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  resolvePnpmGlobalDirFromGlobalRoot,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallTarget,
  type CommandRunner,
  type NpmGlobalPrefixLayout,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

export type PackageUpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
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

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function removePathBestEffort(targetPath: string): Promise<void> {
  await fs
    .rm(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 2,
      retryDelay: 100,
    })
    .catch(() => undefined);
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
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot);
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
        ? resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot)
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
        stderrTail: formatError(err),
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
  let entries: string[] = [];
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
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot);
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
  try {
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    if (await pathExists(targetPackageRoot)) {
      await movePathWithCopyFallback({
        from: targetPackageRoot,
        sourceHardlinks: "reject",
        to: backupRoot,
      });
      movedExisting = true;
    }
    await movePathWithCopyFallback({
      from: params.stage.packageRoot,
      sourceHardlinks: "reject",
      to: targetPackageRoot,
    });
    movedStaged = true;
    await replaceNpmBinShims({
      stageLayout: params.stage.layout,
      targetLayout,
      packageName: params.packageName,
    });
    if (movedExisting) {
      await removePathBestEffort(backupRoot);
    }
    return {
      name: "global install swap",
      command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
      cwd: targetLayout.globalRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: movedExisting
        ? `replaced ${params.packageName}`
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
        sourceHardlinks: "reject",
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
      stderrTail: formatError(err),
    };
  }
}

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
  const installCwd = params.installCwd === undefined ? {} : { cwd: params.installCwd };
  const installEnv = params.env === undefined ? {} : { env: params.env };
  let stagedInstall: StagedNpmInstall | null = null;

  try {
    const preparedInstall = await prepareStagedNpmInstall(params.installTarget, params.packageName);
    stagedInstall = preparedInstall.stagedInstall;
    if (preparedInstall.failedStep) {
      return {
        steps: [preparedInstall.failedStep],
        verifiedPackageRoot: params.packageRoot ?? null,
        afterVersion: null,
        failedStep: preparedInstall.failedStep,
      };
    }

    const installCommandTarget = stagedInstall?.installTarget ?? params.installTarget;
    const installLocation =
      stagedInstall?.prefix ??
      (installCommandTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installCommandTarget.globalRoot)
        : null);
    const updateStep = await params.runStep({
      name: "global update",
      argv: globalInstallArgs(installCommandTarget, params.installSpec, undefined, installLocation),
      ...installCwd,
      ...installEnv,
      timeoutMs: params.timeoutMs,
    });

    const steps = [updateStep];
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
        params.installSpec,
        undefined,
        stagedInstall?.prefix,
      );
      if (fallbackArgv) {
        const fallbackStep = await params.runStep({
          name: "global update (omit optional)",
          argv: fallbackArgv,
          ...installCwd,
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

    const livePackageRoot =
      params.installTarget.packageRoot ??
      params.packageRoot ??
      (
        await resolveGlobalInstallTarget({
          manager: params.installTarget,
          runCommand: params.runCommand,
          timeoutMs: params.timeoutMs,
        })
      ).packageRoot ??
      null;
    const verificationPackageRoot = stagedInstall?.packageRoot ?? livePackageRoot;
    let verifiedPackageRoot = livePackageRoot ?? verificationPackageRoot;

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

    const failedStep =
      finalInstallStep.exitCode !== 0
        ? finalInstallStep
        : (steps.find((step) => step !== updateStep && step.exitCode !== 0) ?? null);

    return {
      steps,
      verifiedPackageRoot,
      afterVersion,
      failedStep,
    };
  } finally {
    await cleanupStagedNpmInstall(stagedInstall);
  }
}
