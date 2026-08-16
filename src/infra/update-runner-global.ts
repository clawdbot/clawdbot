import path from "node:path";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { readPackageName, readPackageVersion } from "./package-json.js";
import { normalizePackageTagInput } from "./package-tag.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import {
  channelToNpmTag,
  DEFAULT_PACKAGE_CHANNEL,
  EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
} from "./update-channels.js";
import { resolveExtendedStablePackage } from "./update-check.js";
import {
  cleanupGlobalRenameDirs,
  createGlobalInstallEnv,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  type GlobalInstallManager,
} from "./update-global.js";
import { normalizeFallbackFailureReason, runStep } from "./update-runner-command.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "./update-runner-doctor.js";
import type { CommandRunner, UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";

const DEFAULT_PACKAGE_NAME = "openclaw";

function normalizeTag(tag?: string) {
  return normalizePackageTagInput(tag, ["openclaw", DEFAULT_PACKAGE_NAME]) ?? "latest";
}

export async function runGlobalUpdate(params: {
  opts: UpdateRunnerOptions;
  pkgRoot: string;
  globalManager: GlobalInstallManager;
  runCommand: CommandRunner;
  timeoutMs: number;
  startedAt: number;
  beforeVersion: string | null;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
}): Promise<UpdateRunResult> {
  const {
    opts,
    pkgRoot,
    globalManager,
    runCommand,
    timeoutMs,
    startedAt,
    beforeVersion,
    allowGatewayServiceRepair,
    allowGatewayActivation,
  } = params;
  const channel = opts.channel ?? DEFAULT_PACKAGE_CHANNEL;
  if (channel === "extended-stable" && opts.tag !== undefined) {
    return {
      status: "error",
      mode: globalManager,
      root: pkgRoot,
      reason: EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
      before: { version: beforeVersion },
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const packageName = (await readPackageName(pkgRoot)) ?? DEFAULT_PACKAGE_NAME;
  const installTarget = await resolveGlobalInstallTarget({
    manager: globalManager,
    runCommand,
    timeoutMs,
    pkgRoot,
    packageName,
  });
  await cleanupGlobalRenameDirs({ globalRoot: path.dirname(pkgRoot), packageName });
  const extendedStable =
    channel === "extended-stable"
      ? await resolveExtendedStablePackage({ installKind: "package", timeoutMs, packageName })
      : null;
  if (extendedStable?.status === "failed") {
    return {
      status: "error",
      mode: globalManager,
      root: pkgRoot,
      reason: extendedStable.reason,
      before: { version: beforeVersion },
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const tag = normalizeTag(
    extendedStable?.status === "resolved"
      ? extendedStable.version
      : (opts.tag ?? channelToNpmTag(channel)),
  );
  const globalInstallEnv = await createGlobalInstallEnv();
  const spec =
    extendedStable?.status === "resolved"
      ? extendedStable.packageSpec
      : resolveGlobalInstallSpec({ packageName, tag, env: globalInstallEnv });

  const packageUpdate = await runGlobalPackageUpdateSteps({
    installTarget,
    installSpec: spec,
    packageName,
    packageRoot: pkgRoot,
    runCommand,
    timeoutMs,
    ...(globalInstallEnv === undefined ? {} : { env: globalInstallEnv }),
    installCwd: pkgRoot,
    runStep: (stepParams) =>
      runStep({
        runCommand,
        ...stepParams,
        cwd: stepParams.cwd ?? pkgRoot,
        progress: opts.progress,
        stepIndex: 0,
        totalSteps: 1,
      }),
    postVerifyStep: async (verifiedPackageRoot) => {
      const doctorEntry = await resolveGatewayInstallEntrypoint(verifiedPackageRoot);
      if (!doctorEntry) {
        return null;
      }
      const doctorNodePath = await resolveStableNodePath(process.execPath);
      const candidateHostVersion = await readPackageVersion(verifiedPackageRoot);
      const doctorPolicy = resolveUpdateDoctorExecutionPolicy({
        targetVersion: candidateHostVersion,
        allowGatewayServiceRepair,
      });
      return await runStep({
        runCommand,
        name: "openclaw doctor",
        argv: [
          doctorNodePath,
          doctorEntry,
          "doctor",
          "--non-interactive",
          ...(doctorPolicy.fix ? ["--fix"] : []),
        ],
        cwd: verifiedPackageRoot,
        timeoutMs,
        env: buildUpdateDoctorEnv({
          allowGatewayServiceRepair,
          allowGatewayActivation,
          serviceRepairPolicy: doctorPolicy.serviceRepairPolicy,
          compatibilityHostVersion: candidateHostVersion,
        }),
        progress: opts.progress,
        stepIndex: 0,
        totalSteps: 1,
      });
    },
  });

  return {
    status: packageUpdate.failedStep ? "error" : "ok",
    mode: globalManager,
    root: packageUpdate.verifiedPackageRoot ?? pkgRoot,
    reason: packageUpdate.failedStep
      ? normalizeFallbackFailureReason(packageUpdate.failedStep.name)
      : undefined,
    before: { version: beforeVersion },
    after: { version: packageUpdate.afterVersion },
    steps: packageUpdate.steps,
    durationMs: Date.now() - startedAt,
  };
}
