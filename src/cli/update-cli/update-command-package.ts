import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { createLowDiskSpaceWarning } from "../../infra/disk-space.js";
import {
  markPackagePostInstallDoctorAdvisory,
  runGlobalPackageUpdateSteps,
} from "../../infra/package-update-steps.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../../infra/update-doctor-result.js";
import {
  createGlobalInstallEnv,
  cleanupGlobalRenameDirs,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import {
  resolveUpdateDoctorExecutionPolicy,
  type UpdateRunResult,
} from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCliName } from "../cli-name.js";
import { createUpdateProgress } from "./progress.js";
import {
  DEFAULT_PACKAGE_NAME,
  createGlobalCommandRunner,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resolveNodeRunner,
  runUpdateStep,
} from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config.js";
import { resolvePostInstallDoctorEnv } from "./update-command-service.js";

const CLI_NAME = resolveCliName();

export async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  installSpec?: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  jsonMode: boolean;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  honorPackageRoot?: boolean;
  nodeRunner?: string;
  installEnv?: NodeJS.ProcessEnv;
  installTarget?: ResolvedGlobalInstallTarget;
}): Promise<UpdateRunResult> {
  const installEnv = params.installEnv ?? (await createGlobalInstallEnv());
  const runCommand = createGlobalCommandRunner();
  let installTarget = params.installTarget;
  if (!installTarget) {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: params.timeoutMs,
    });
    installTarget = await resolveGlobalInstallTarget({
      manager,
      runCommand,
      timeoutMs: params.timeoutMs,
      pkgRoot: params.root,
      honorPackageRoot: params.honorPackageRoot === true,
    });
  }
  const pkgRoot = installTarget.packageRoot;
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;
  const installSpec =
    params.installSpec ??
    resolveGlobalInstallSpec({
      packageName,
      tag: params.tag,
      env: installEnv,
    });

  const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
  if (pkgRoot) {
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
  }

  const diskWarning = createLowDiskSpaceWarning({
    targetPath: pkgRoot ? path.dirname(pkgRoot) : params.root,
    purpose: "global package update",
  });
  if (diskWarning) {
    if (params.jsonMode) {
      defaultRuntime.error(`Warning: ${diskWarning}`);
    } else {
      defaultRuntime.log(theme.warn(diskWarning));
    }
  }

  const packageUpdate = await runGlobalPackageUpdateSteps({
    installTarget,
    installSpec,
    packageName,
    packageRoot: pkgRoot,
    runCommand,
    timeoutMs: params.timeoutMs,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    runStep: (stepParams) =>
      runUpdateStep({
        ...stepParams,
        progress: params.progress,
      }),
    postVerifyStep: async (verifiedPackageRoot) => {
      const entryPath = await resolveGatewayInstallEntrypoint(verifiedPackageRoot);
      if (!entryPath) {
        return null;
      }
      await createUpdateConfigSnapshot();
      const candidateHostVersion = await readPackageVersion(verifiedPackageRoot);
      const doctorResultPath = createUpdatePostInstallDoctorResultPath();
      const doctorPolicy = resolveUpdateDoctorExecutionPolicy({
        targetVersion: candidateHostVersion,
        allowGatewayServiceRepair: params.allowGatewayServiceRepair,
      });
      const doctorArgv = [
        params.nodeRunner ?? resolveNodeRunner(),
        entryPath,
        "doctor",
        "--non-interactive",
        ...(doctorPolicy.fix ? ["--fix"] : []),
      ];
      const doctorProgressInfo = {
        name: `${CLI_NAME} doctor`,
        command: doctorArgv.join(" "),
        index: 0,
        total: 0,
      };
      params.progress?.onStepStart?.(doctorProgressInfo);
      const doctorStep = await runUpdateStep({
        name: `${CLI_NAME} doctor`,
        argv: doctorArgv,
        cwd: verifiedPackageRoot,
        env: {
          ...resolvePostInstallDoctorEnv({
            serviceEnv: params.managedServiceEnv,
            invocationCwd: params.invocationCwd,
          }),
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
          [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
          [UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV]: "1",
          [UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV]: params.allowGatewayServiceRepair
            ? "1"
            : "0",
          [UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV]: params.allowGatewayActivation ? "1" : "0",
          ...(doctorPolicy.serviceRepairPolicy
            ? { OPENCLAW_SERVICE_REPAIR_POLICY: doctorPolicy.serviceRepairPolicy }
            : {}),
          [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath,
          ...(candidateHostVersion === null
            ? {}
            : { OPENCLAW_COMPATIBILITY_HOST_VERSION: candidateHostVersion }),
        },
        timeoutMs: params.timeoutMs,
      });
      const doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
      const completedDoctorStep = markPackagePostInstallDoctorAdvisory(doctorStep, doctorResult);
      params.progress?.onStepComplete?.({
        ...doctorProgressInfo,
        durationMs: completedDoctorStep.durationMs,
        exitCode: completedDoctorStep.exitCode,
        stderrTail: completedDoctorStep.stderrTail,
        signal: completedDoctorStep.signal,
        killed: completedDoctorStep.killed,
        termination: completedDoctorStep.termination,
        advisory: completedDoctorStep.advisory,
      });
      return completedDoctorStep;
    },
  });

  return {
    status: packageUpdate.failedStep ? "error" : "ok",
    mode: installTarget.manager,
    root: packageUpdate.verifiedPackageRoot ?? params.root,
    reason: packageUpdate.failedStep ? packageUpdate.failedStep.name : undefined,
    before: { version: beforeVersion },
    after: { version: packageUpdate.afterVersion ?? beforeVersion },
    steps: packageUpdate.steps,
    durationMs: Date.now() - params.startedAt,
  };
}
