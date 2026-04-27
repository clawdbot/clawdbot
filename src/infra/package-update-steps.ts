import { readPackageVersion } from "./package-json.js";
import {
  collectInstalledGlobalPackageErrors,
  globalInstallArgs,
  globalInstallFallbackArgs,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallTarget,
  type CommandRunner,
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

export type PackageUpdateStepRunner = (params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<PackageUpdateStepResult>;

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
  const updateStep = await params.runStep({
    name: "global update",
    argv: globalInstallArgs(params.installTarget, params.installSpec),
    ...installCwd,
    ...installEnv,
    timeoutMs: params.timeoutMs,
  });

  const steps = [updateStep];
  let finalInstallStep = updateStep;
  if (updateStep.exitCode !== 0) {
    const fallbackArgv = globalInstallFallbackArgs(params.installTarget, params.installSpec);
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
    }
  }

  const verifiedPackageRoot =
    (
      await resolveGlobalInstallTarget({
        manager: params.installTarget,
        runCommand: params.runCommand,
        timeoutMs: params.timeoutMs,
      })
    ).packageRoot ??
    params.packageRoot ??
    null;

  let afterVersion: string | null = null;
  if (verifiedPackageRoot) {
    afterVersion = await readPackageVersion(verifiedPackageRoot);
    const expectedVersion = resolveExpectedInstalledVersionFromSpec(
      params.packageName,
      params.installSpec,
    );
    const verificationErrors = await collectInstalledGlobalPackageErrors({
      packageRoot: verifiedPackageRoot,
      expectedVersion,
    });
    if (verificationErrors.length > 0) {
      steps.push({
        name: "global install verify",
        command: `verify ${verifiedPackageRoot}`,
        cwd: verifiedPackageRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: verificationErrors.join("\n"),
        stdoutTail: null,
      });
    }
    const postVerifyStep = await params.postVerifyStep?.(verifiedPackageRoot);
    if (postVerifyStep) {
      steps.push(postVerifyStep);
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
}
