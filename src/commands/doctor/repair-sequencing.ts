import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./shared/allowlist-policy-repair.js";
import { maybeRepairBundledPluginLoadPaths } from "./shared/bundled-plugin-load-paths.js";
import {
  createChannelDoctorEmptyAllowlistPolicyHooks,
  collectChannelDoctorRepairMutations,
} from "./shared/channel-doctor.js";
import {
  applyDoctorConfigMutation,
  type DoctorConfigMutationState,
} from "./shared/config-mutation-state.js";
import { scanEmptyAllowlistPolicyWarnings } from "./shared/empty-allowlist-scan.js";
import { maybeRepairExecSafeBinProfiles } from "./shared/exec-safe-bins.js";
import { maybeRepairInvalidPluginConfig } from "./shared/invalid-plugin-config.js";
import { maybeRepairLegacyToolsBySenderKeys } from "./shared/legacy-tools-by-sender.js";
import { repairMissingConfiguredPluginInstalls } from "./shared/missing-configured-plugin-install.js";
import { maybeRepairOpenPolicyAllowFrom } from "./shared/open-policy-allowfrom.js";
import { cleanupLegacyPluginDependencyState } from "./shared/plugin-dependency-cleanup.js";
import { maybeRepairStalePluginConfig } from "./shared/stale-plugin-config.js";

const UPDATE_IN_PROGRESS_ENV = "OPENCLAW_UPDATE_IN_PROGRESS";

function isUpdatePackageDoctorPass(env: NodeJS.ProcessEnv): boolean {
  return env[UPDATE_IN_PROGRESS_ENV] === "1";
}

export async function runDoctorRepairSequence(params: {
  state: DoctorConfigMutationState;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  state: DoctorConfigMutationState;
  changeNotes: string[];
  warningNotes: string[];
}> {
  let state = params.state;
  const changeNotes: string[] = [];
  const warningNotes: string[] = [];
  const env = params.env ?? process.env;
  const sanitizeLines = (lines: string[]) => lines.map((line) => sanitizeForLog(line)).join("\n");

  const applyMutation = (mutation: {
    config: DoctorConfigMutationState["candidate"];
    changes: string[];
    warnings?: string[];
  }) => {
    if (mutation.changes.length > 0) {
      changeNotes.push(sanitizeLines(mutation.changes));
      state = applyDoctorConfigMutation({
        state,
        mutation,
        shouldRepair: true,
      });
    }
    if (mutation.warnings && mutation.warnings.length > 0) {
      warningNotes.push(sanitizeLines(mutation.warnings));
    }
  };

  for (const mutation of await collectChannelDoctorRepairMutations({
    cfg: state.candidate,
    doctorFixCommand: params.doctorFixCommand,
    env,
  })) {
    applyMutation(mutation);
  }
  applyMutation(maybeRepairOpenPolicyAllowFrom(state.candidate));
  applyMutation(maybeRepairBundledPluginLoadPaths(state.candidate, env));
  const missingConfiguredPluginInstallRepair = await repairMissingConfiguredPluginInstalls({
    cfg: state.candidate,
    env,
  });
  if (missingConfiguredPluginInstallRepair.changes.length > 0) {
    changeNotes.push(sanitizeLines(missingConfiguredPluginInstallRepair.changes));
    applyMutation(applyPluginAutoEnable({ config: state.candidate, env }));
  }
  if (missingConfiguredPluginInstallRepair.warnings.length > 0) {
    warningNotes.push(sanitizeLines(missingConfiguredPluginInstallRepair.warnings));
  }
  const missingConfiguredPluginInstallFailed =
    missingConfiguredPluginInstallRepair.warnings.length > 0;
  if (!isUpdatePackageDoctorPass(env) && !missingConfiguredPluginInstallFailed) {
    applyMutation(maybeRepairStalePluginConfig(state.candidate, env));
  }
  applyMutation(maybeRepairInvalidPluginConfig(state.candidate));
  applyMutation(await maybeRepairAllowlistPolicyAllowFrom(state.candidate));

  const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(state.candidate, {
    doctorFixCommand: params.doctorFixCommand,
    ...createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: state.candidate, env }),
  });
  if (emptyAllowlistWarnings.length > 0) {
    warningNotes.push(sanitizeLines(emptyAllowlistWarnings));
  }

  applyMutation(maybeRepairLegacyToolsBySenderKeys(state.candidate));
  applyMutation(maybeRepairExecSafeBinProfiles(state.candidate));
  const pluginDependencyCleanup = await cleanupLegacyPluginDependencyState({ env });
  if (pluginDependencyCleanup.changes.length > 0) {
    changeNotes.push(sanitizeLines(pluginDependencyCleanup.changes));
  }
  if (pluginDependencyCleanup.warnings.length > 0) {
    warningNotes.push(sanitizeLines(pluginDependencyCleanup.warnings));
  }

  return { state, changeNotes, warningNotes };
}
