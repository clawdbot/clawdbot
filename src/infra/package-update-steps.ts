// Runs package update move, inventory, and cleanup steps.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { resolveBunGlobalInstallOwner } from "./detect-package-manager.js";
import { formatErrorMessage } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import { completePendingPackageLifecycle } from "./package-lifecycle.js";
import {
  isBlockingPackageUpdateStep,
  PackageUpdateActivationError,
  readPackageVersionIfPresent,
  removePackageUpdatePath,
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
  type StagedPackageInstall,
} from "./package-update-swap.js";
import { trimLogTail } from "./restart-sentinel.js";
import {
  PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
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
import { prepareNativePackageStage } from "./update-native-package-stage.js";
import type { UpdateRecovery } from "./update-recovery.js";
import type { UpdateStepResult } from "./update-runner-types.js";
export type { PackageUpdateTransaction } from "./package-update-swap.js";

type PackageUpdateStepRunner = (params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<UpdateStepResult>;

type PackageUpdateStepsResult = {
  reason?: "already-current";
  steps: UpdateStepResult[];
  activePackageRoot: string | null;
  afterVersion: string | null;
  failedStep: UpdateStepResult | null;
  recovery: UpdateRecovery;
};

const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"] as const;

async function resolveNpmUpdateLifecyclePolicy(params: {
  installTarget: ResolvedGlobalInstallTarget;
}): Promise<{
  policy: ReturnType<typeof resolveNpmLifecyclePolicyGate>["policy"];
  failedStep: UpdateStepResult | null;
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
  name?: string;
  cwd?: string;
}): Promise<{
  result: Awaited<ReturnType<CommandRunner>> | null;
  failedStep: UpdateStepResult | null;
}> {
  const startedAt = Date.now();
  const argv = [params.installTarget.command, ...params.args];
  const probeCwd = params.cwd ?? params.installTarget.globalRoot ?? undefined;
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
        name: params.name ?? "pnpm isolated install preflight",
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
        name: params.name ?? "pnpm isolated install preflight",
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
  failedStep: UpdateStepResult | null;
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
    advisory?: UpdateStepResult["advisory"];
  },
>(
  step: T,
  result: UpdatePostInstallDoctorResult | null,
): T & {
  advisory?: UpdateStepResult["advisory"];
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

function resolveNativeInstallSpecFromCwd(
  spec: string,
  packageName: string,
  sourceCwd: string,
  manager: "pnpm" | "bun",
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
    // Bun's link: names refer to its global link registry, not caller-relative directories.
    if (manager === "bun" && protocol.toLowerCase() === "link:") {
      return spec;
    }
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
  const protocol = manager === "bun" || /\.(?:tgz|tar\.gz|tar)$/iu.test(target) ? "file" : "link";
  return `${aliasPrefix}${protocol}:${target}`;
}

async function createStagedPackageInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<StagedPackageInstall | null> {
  const targetLayout = resolveStagedNpmTargetLayout(installTarget);
  if (!targetLayout) {
    return null;
  }
  await fs.mkdir(targetLayout.globalRoot, { recursive: true });
  // Active stages must stay outside cleanupGlobalRenameDirs' disposable ".openclaw-" namespace.
  const prefix = await fs.mkdtemp(path.join(targetLayout.globalRoot, ".openclaw.update-stage-"));
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
  steps: UpdateStepResult[];
  failedStep: UpdateStepResult | null;
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
    const failedStep: UpdateStepResult = {
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

async function prepareStagedPackageInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
  nativeOptions?: { env: NodeJS.ProcessEnv; globalBinDir?: string; installSpec: string },
  requireStaging = false,
): Promise<{
  stagedInstall: StagedPackageInstall | null;
  failedStep: UpdateStepResult | null;
}> {
  const startedAt = Date.now();
  try {
    if (nativeOptions) {
      const native = await prepareNativePackageStage({
        installTarget,
        packageName,
        ...nativeOptions,
      });
      if (!native) {
        throw new Error("Cannot resolve the native package manager's staging owner.");
      }
      // Isolated pnpm resolves its newly created owner after installation.
      const packageRoot = path.join(native.globalRoot, packageName);
      return {
        stagedInstall: {
          prefix: native.prefix,
          layout: {
            prefix: native.projectRoot,
            globalRoot: native.globalRoot,
            binDir: native.binDir,
          },
          packageRoot,
          installTarget: { ...installTarget, globalRoot: native.globalRoot, packageRoot },
          native,
        },
        failedStep: null,
      };
    }
    const stagedInstall = await createStagedPackageInstall(installTarget, packageName);
    if (!stagedInstall && requireStaging) {
      throw new Error(
        `The ${installTarget.manager} global install layout cannot stage a candidate. Reinstall with ${installTarget.manager} into its default global layout, then retry the update.`,
      );
    }
    return { stagedInstall, failedStep: null };
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
        command: `prepare staged ${installTarget.manager} install`,
        cwd: targetLayout?.prefix ?? installTarget.globalRoot ?? process.cwd(),
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatErrorMessage(err),
      },
    };
  }
}

async function cleanupStagedPackageInstall(stage: StagedPackageInstall | null): Promise<void> {
  if (stage) {
    if (stage.native) {
      await removePackageUpdatePath(stage.native.binDir);
    }
    await removePackageUpdatePath(stage.prefix);
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
  postVerifyStep?: (packageRoot: string) => Promise<UpdateStepResult | null>;
  validateCandidate?: (packageRoot: string) => Promise<UpdateStepResult[]>;
  beforeActivate?: () => Promise<void>;
  onTransaction?: (transaction: PackageUpdateTransaction) => void;
  expectedGitCheckout?: GitRuntimeIdentity;
  activateGitRoot?: string;
}): Promise<PackageUpdateStepsResult> {
  // Transaction callbacks must never silently become an in-place manager install.
  const requireStaging = Boolean(
    params.validateCandidate ||
    params.beforeActivate ||
    params.onTransaction ||
    params.activateGitRoot,
  );
  let stagedInstall: StagedPackageInstall | null = null;
  let packedInstallDir: string | null = null;
  const originalPackageRoot = params.installTarget.packageRoot ?? params.packageRoot ?? null;
  let activePackageRoot = originalPackageRoot;
  let afterVersion: string | null = null;
  const initialRecovery = await verifyPackageUpdateRecovery(originalPackageRoot);
  let liveTreeMutated = false;
  let packageRollbackVerified: boolean | undefined;
  const steps: UpdateStepResult[] = [];
  const packageUpdateFailure = async (
    failedStep: UpdateStepResult,
    failedSteps = [failedStep],
  ): Promise<PackageUpdateStepsResult> => {
    let recovery: UpdateRecovery = liveTreeMutated
      ? {
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          ...(packageRollbackVerified === undefined ? {} : { packageRollbackVerified }),
        }
      : initialRecovery;
    // A discarded stage must not hide damage to the live tree. Before mutation,
    // recovery still belongs to the original runtime, verified again at failure.
    if (!liveTreeMutated && initialRecovery.serviceRestartSafe) {
      const liveRecovery = await verifyPackageUpdateRecovery(originalPackageRoot);
      recovery =
        liveRecovery.serviceRestartSafe && liveRecovery.version === initialRecovery.version
          ? liveRecovery
          : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
    }
    return {
      steps: failedSteps,
      activePackageRoot,
      afterVersion,
      failedStep,
      recovery,
    };
  };

  try {
    const npmPreflight = await resolveNpmUpdateLifecyclePolicy({
      installTarget: params.installTarget,
    });
    if (npmPreflight.failedStep) {
      return await packageUpdateFailure(npmPreflight.failedStep);
    }
    const pnpmPreflight = await validatePnpmIsolatedUpdate({
      installTarget: params.installTarget,
      packageName: params.packageName,
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
    if (pnpmPreflight.failedStep) {
      return await packageUpdateFailure(pnpmPreflight.failedStep);
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
    const stageNative = params.installTarget.manager !== "npm" && requireStaging;
    let globalBinDir = pnpmPreflight.globalBinDir ?? undefined;
    if (stageNative && !globalBinDir) {
      const bin = await runPnpmPreflightProbe({
        ...params,
        env: effectiveInstallEnv,
        args: params.installTarget.manager === "bun" ? ["pm", "bin", "-g"] : ["bin", "-g"],
        name: `${params.installTarget.manager} staging preflight`,
      });
      if (bin.failedStep) {
        return await packageUpdateFailure(bin.failedStep);
      }
      globalBinDir = bin.result
        ? readPackageManagerProbeValue(bin.result.stdout) || undefined
        : undefined;
    }
    const nativeOptions = stageNative
      ? { env: effectiveInstallEnv ?? process.env, globalBinDir, installSpec: params.installSpec }
      : undefined;
    const preparedInstall = await prepareStagedPackageInstall(
      params.installTarget,
      params.packageName,
      nativeOptions,
      requireStaging,
    );
    stagedInstall = preparedInstall.stagedInstall;
    if (preparedInstall.failedStep) {
      return await packageUpdateFailure(preparedInstall.failedStep);
    }
    const commandEnv = stagedInstall?.native?.env ?? effectiveInstallEnv;
    const installEnv = commandEnv === undefined ? {} : { env: commandEnv };

    if (params.installTarget.manager === "pnpm" && stagedInstall?.native) {
      const stage = stagedInstall.native;
      for (const [probeName, expectedPath] of [
        ["root", stage.globalRoot],
        ["bin", stage.binDir],
      ] as const) {
        const args = [probeName, "-g", ...stage.configArgs];
        const probe = await runPnpmPreflightProbe({
          ...params,
          args,
          cwd: stage.projectRoot,
          env: stage.env,
          name: "pnpm staging preflight",
        });
        const reportedPath = probe.result && readPackageManagerProbeValue(probe.result.stdout);
        if (
          !reportedPath ||
          (await resolveCanonicalPath(reportedPath)) !== (await resolveCanonicalPath(expectedPath))
        ) {
          const failedStep = probe.failedStep ?? {
            name: "pnpm staging preflight",
            command: [params.installTarget.command, ...args].join(" "),
            cwd: stage.projectRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: `pnpm ${probeName} selected ${reportedPath || "an unknown path"}, expected staged destination ${expectedPath}. The live installation was left unchanged.`,
          };
          return await packageUpdateFailure(failedStep, [...steps, failedStep]);
        }
      }
    }

    const installCommandTarget = stagedInstall?.installTarget ?? params.installTarget;
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
      return await packageUpdateFailure(preparedSpec.failedStep, steps);
    }

    // pnpm selects its version from cwd. Keep every pnpm mutation beside its
    // detected global root, after preserving caller-relative package specs.
    const pnpmMutationCwd =
      installCommandTarget.manager === "pnpm" ? installCommandTarget.globalRoot : null;
    const updateCwd =
      stagedInstall?.native?.projectRoot ?? pnpmMutationCwd ?? preparedSpec.installCwd;
    const updateInstallSpec =
      installCommandTarget.manager !== "npm"
        ? resolveNativeInstallSpecFromCwd(
            preparedSpec.installSpec,
            params.packageName,
            preparedSpec.installCwd ?? process.cwd(),
            installCommandTarget.manager,
          )
        : preparedSpec.installSpec;
    liveTreeMutated ||= !stagedInstall;
    const updateStep = await params.runStep({
      name: "global update",
      argv: [
        ...globalInstallArgs(
          installCommandTarget,
          updateInstallSpec,
          undefined,
          stagedInstall?.prefix,
          preparedSpec.installCwd,
          npmPreflight.policy ?? undefined,
        ),
        ...(stagedInstall?.native?.configArgs ?? []),
      ],
      ...(updateCwd ? { cwd: updateCwd } : {}),
      ...installEnv,
      timeoutMs: params.timeoutMs,
    });

    steps.push(updateStep);
    let finalInstallStep = updateStep;
    if (updateStep.exitCode !== 0) {
      await cleanupStagedPackageInstall(stagedInstall);
      stagedInstall = null;
      const preparedFallbackInstall =
        installCommandTarget.manager === "npm"
          ? await prepareStagedPackageInstall(
              params.installTarget,
              params.packageName,
              undefined,
              requireStaging,
            )
          : { stagedInstall: null, failedStep: null };
      stagedInstall = preparedFallbackInstall.stagedInstall;
      if (preparedFallbackInstall.failedStep) {
        steps.push(preparedFallbackInstall.failedStep);
        return await packageUpdateFailure(preparedFallbackInstall.failedStep, steps);
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
        liveTreeMutated ||= !stagedInstall;
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
        await cleanupStagedPackageInstall(stagedInstall);
        stagedInstall = null;
      }
    }

    if (
      stagedInstall?.native &&
      params.installTarget.pnpmIsolated &&
      finalInstallStep.exitCode === 0
    ) {
      const activePackages = await listActivePnpmIsolatedGlobalPackages({
        globalRoot: stagedInstall.native.globalRoot,
        packageName: params.packageName,
      });
      const candidate = activePackages.length === 1 ? activePackages[0] : undefined;
      if (!candidate) {
        const failedStep: UpdateStepResult = {
          name: "global install verify",
          command: "resolve staged pnpm replacement",
          cwd: stagedInstall.native.projectRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: "could not identify a unique active staged pnpm replacement package",
        };
        return await packageUpdateFailure(failedStep, [...steps, failedStep]);
      }
      stagedInstall.packageRoot = candidate.packageRoot;
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
      activePackageRoot = null;
      const replacementStep: UpdateStepResult = {
        name: "global install verify",
        command: `resolve pnpm replacement in ${params.installTarget.globalRoot ?? "unknown root"}`,
        cwd: params.installTarget.globalRoot ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stderrTail: "could not identify a unique active pnpm replacement package",
      };
      steps.push(replacementStep);
      return await packageUpdateFailure(replacementStep, steps);
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
    if (!stagedInstall) {
      activePackageRoot = livePackageRoot;
    }
    if (finalInstallStep.exitCode === 0 && !verificationPackageRoot) {
      const failedStep: UpdateStepResult = {
        name: "global install verify",
        command: "resolve installed package",
        cwd: updateCwd ?? process.cwd(),
        durationMs: 0,
        exitCode: 1,
        stderrTail: "could not identify the installed package root",
      };
      return await packageUpdateFailure(failedStep, [...steps, failedStep]);
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
      // Verify the requested candidate before admitting a package-version no-op.
      // Source exposure follows the Git SHA contract instead.
      if (
        verificationErrors.length === 0 &&
        stagedInstall &&
        !params.expectedGitCheckout &&
        requireStaging &&
        candidateVersion &&
        candidateVersion === (await readPackageVersionIfPresent(originalPackageRoot))
      ) {
        return {
          reason: "already-current",
          steps,
          activePackageRoot: originalPackageRoot,
          afterVersion: candidateVersion,
          failedStep: null,
          recovery: await verifyPackageUpdateRecovery(originalPackageRoot),
        };
      }
      // v2026.8.1 alone shipped this pending marker inside the closed dist inventory.
      const blockingVerificationErrors = verificationErrors.filter(
        (error) =>
          params.installSpec !== "openclaw@2026.8.1" ||
          error !== `unexpected packaged dist file ${LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`,
      );
      if (blockingVerificationErrors.length === 0) {
        let failedLifecycleStep: UpdateStepResult | null = null;
        try {
          const completedLifecycle = await completePendingPackageLifecycle({
            packageRoot: verificationPackageRoot,
            timeoutMs: params.timeoutMs,
            runScript: async (script) => {
              const lifecycleStep = await params.runStep({
                name: `${params.installTarget.manager} package ${script.name}`,
                argv: [process.execPath, path.join(verificationPackageRoot, script.relativePath)],
                cwd: verificationPackageRoot,
                env: commandEnv,
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
            return await packageUpdateFailure(failedLifecycleStep, steps);
          }
          const lifecycleStep: UpdateStepResult = {
            name: `${params.installTarget.manager} package lifecycle`,
            command: `complete ${verificationPackageRoot}`,
            cwd: verificationPackageRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: formatErrorMessage(error),
          };
          steps.push(lifecycleStep);
          return await packageUpdateFailure(lifecycleStep, steps);
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
      if (stagedInstall && verificationErrors.length === 0) {
        const validation = (await params.validateCandidate?.(verificationPackageRoot)) ?? [];
        steps.push(...validation);
        const rejectedCandidate = validation.find(isBlockingPackageUpdateStep);
        if (rejectedCandidate) {
          return await packageUpdateFailure(rejectedCandidate, steps);
        }
        if (params.activateGitRoot) {
          if (
            stagedInstall.native ||
            !params.expectedGitCheckout ||
            !(await fs.lstat(stagedInstall.packageRoot)).isSymbolicLink()
          ) {
            throw new Error(
              "Prepared source checkout exposure requires an npm package symlink; the current installation has not been changed.",
            );
          }
          // The source owner publishes this exact root inside beforeActivate. Rebind only
          // after validating the temporary candidate, so its cleanup cannot break exposure.
          await fs.unlink(stagedInstall.packageRoot);
          await fs.symlink(
            path.resolve(params.activateGitRoot),
            stagedInstall.packageRoot,
            process.platform === "win32" ? "junction" : undefined,
          );
        }
        const swap = await swapStagedPackageInstall({
          stage: stagedInstall,
          installTarget: params.installTarget,
          packageName: params.packageName,
          postVerifyStep: params.postVerifyStep,
          beforeActivate: params.beforeActivate,
          onLiveMutation: () => {
            liveTreeMutated = true;
          },
          onTransaction: params.onTransaction,
        });
        steps.push(swap.step);
        if (swap.postVerifyStep) {
          steps.push(swap.postVerifyStep);
        }
        failedVerification = swap.status === "failed";
        activePackageRoot = swap.activePackageRoot;
        // Verified rollback restores package files, not state changed by hooks.
        if (swap.status === "committed") {
          afterVersion = candidateVersion;
        } else {
          packageRollbackVerified = swap.packageRollbackVerified;
        }
      }

      if (!stagedInstall && !failedVerification) {
        const postVerifyStep = activePackageRoot
          ? ((await params.postVerifyStep?.(activePackageRoot)) ?? null)
          : null;
        if (postVerifyStep) {
          steps.push(postVerifyStep);
        } else if (params.postVerifyStep) {
          steps.push({
            name: "post-install verification",
            command: "verify installed package",
            cwd: activePackageRoot ?? process.cwd(),
            durationMs: 0,
            exitCode: 1,
            stderrTail:
              "Required post-install verification did not produce a result; Gateway activation is unsafe.",
          });
        }
      }
      if (failedVerification && stagedInstall) {
        afterVersion = await readPackageVersionIfPresent(activePackageRoot);
      }
    }

    const failedStep = isBlockingPackageUpdateStep(finalInstallStep)
      ? finalInstallStep
      : (steps.find((step) => step !== updateStep && isBlockingPackageUpdateStep(step)) ?? null);

    if (failedStep) {
      return await packageUpdateFailure(failedStep, steps);
    }
    return {
      steps,
      activePackageRoot,
      afterVersion,
      failedStep,
      recovery: afterVersion
        ? { serviceRestartSafe: true, version: afterVersion }
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    };
  } catch (error) {
    if (error instanceof PackageUpdateActivationError) {
      throw error.cause;
    }
    const failedStep: UpdateStepResult = {
      name: "package update",
      command: "update installed package",
      cwd: activePackageRoot ?? params.installCwd ?? process.cwd(),

      durationMs: 0,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
    };
    return await packageUpdateFailure(failedStep, [...steps, failedStep]);
  } finally {
    await cleanupStagedPackageInstall(stagedInstall);
    if (packedInstallDir) {
      await removePackageUpdatePath(packedInstallDir);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
