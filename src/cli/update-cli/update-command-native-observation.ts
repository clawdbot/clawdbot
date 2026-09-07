import { isDeepStrictEqual } from "node:util";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveLaunchAgentGuiDomain } from "../../daemon/launchd-runtime.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayServiceState,
} from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import type {
  UpdateRecoveryNativeIdentity,
  UpdateRecoveryNativeObservation,
} from "../../infra/update-run-recovery-native.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { gatewayServiceCommandUsesRoot } from "./update-command-service-plan.js";

/** Observations are evidence only. The caller retains its native lock and live
 * executor through inspection and the Recovery owner's exact-revision write.
 */
export async function readUpdateCommandNativeObservation(params: {
  record: Pick<UpdateRecoveryRecord, "runId" | "source" | "from">;
  env: NodeJS.ProcessEnv;
  definitionPaths: readonly string[];
  assertCurrent: () => void;
  timeoutMs?: number;
}): Promise<UpdateRecoveryNativeObservation> {
  const unavailable = () =>
    new UpdateCommandRecoveryPendingError("Original native-manager state cannot be verified.");
  const source = params.record.source;
  if (!source || source.profile === undefined) {
    throw unavailable();
  }
  params.assertCurrent();
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, {
    env: params.env,
    requireEffective: true,
    requireLoadedCommand: true,
    timeoutMs: params.timeoutMs,
  });
  params.assertCurrent();
  if (
    !state.installed ||
    !state.command?.sourcePath ||
    state.loadState.status === "unknown" ||
    !["running", "stopped"].includes(state.runtime?.status ?? "") ||
    resolveStateDir(state.env) !== source.stateDir ||
    resolveConfigPath(state.env) !== source.configPath ||
    (state.env.OPENCLAW_PROFILE?.trim() || null) !== source.profile ||
    !isDeepStrictEqual(
      [...new Set([state.command.sourcePath, ...(state.command.definitionPaths ?? [])])].toSorted(),
      [...new Set(params.definitionPaths)].toSorted(),
    )
  ) {
    throw unavailable();
  }
  const belongsToRoot = await gatewayServiceCommandUsesRoot({
    root: params.record.from.root,
    env: state.env,
    command: state.command,
  });
  params.assertCurrent();
  if (!belongsToRoot || !service.isEnabled) {
    throw unavailable();
  }
  const enabled = await service.isEnabled({ env: state.env, timeoutMs: params.timeoutMs });
  params.assertCurrent();
  // Enable inspection awaits native work. Do not combine its result with an
  // earlier process/manager generation that changed in the meantime.
  const finalState = await readGatewayServiceState(service, {
    env: params.env,
    requireEffective: true,
    requireLoadedCommand: true,
    timeoutMs: params.timeoutMs,
  });
  params.assertCurrent();
  const identityFacts = (value: GatewayServiceState) => ({
    installed: value.installed,
    command: value.command,
    env: value.env,
    loadState: value.loadState.status,
    status: value.runtime?.status,
    pid: value.runtime?.pid,
    unit: value.runtime?.systemd?.unit,
    managerUid: value.runtime?.systemd?.managerUid,
  });
  if (!isDeepStrictEqual(identityFacts(state), identityFacts(finalState))) {
    throw unavailable();
  }
  const finalEnabled = await service.isEnabled({ env: state.env, timeoutMs: params.timeoutMs });
  params.assertCurrent();
  if (enabled !== finalEnabled) {
    throw unavailable();
  }
  // Close the observation interval after the final policy await as well. A
  // concurrent native transition cannot borrow the preceding state snapshot.
  const closingState = await readGatewayServiceState(service, {
    env: params.env,
    requireEffective: true,
    requireLoadedCommand: true,
    timeoutMs: params.timeoutMs,
  });
  params.assertCurrent();
  if (!isDeepStrictEqual(identityFacts(state), identityFacts(closingState))) {
    throw unavailable();
  }
  const binding = {
    runId: params.record.runId,
    stateDir: source.stateDir,
    configPath: source.configPath,
    profile: source.profile,
  };
  let identity: UpdateRecoveryNativeIdentity;
  let loaded: boolean;
  if (process.platform === "darwin") {
    identity = {
      ...binding,
      platform: "darwin",
      domain: resolveLaunchAgentGuiDomain(),
      label: resolveLaunchAgentLabel(state.env),
    };
    loaded = state.loadState.status === "loaded";
  } else if (process.platform === "linux") {
    const native = state.runtime?.systemd;
    const unitName = `${resolveSystemdServiceName(state.env)}.service`;
    if (
      native?.unit !== unitName ||
      typeof native.managerUid !== "number" ||
      !Number.isInteger(native.managerUid) ||
      native.managerUid < 0 ||
      native.managerUid >= 0xffffffff
    ) {
      throw unavailable();
    }
    // requireLoaded uses the daemon's non-activating GetUnit reader. Successful
    // runtime inspection proves loaded, independently of is-enabled policy.
    identity = { ...binding, platform: "linux", scope: "user", unitName, uid: native.managerUid };
    loaded = true;
  } else if (process.platform === "win32") {
    if (state.loadState.status !== "loaded") {
      throw unavailable();
    }
    identity = { ...binding, platform: "win32", taskName: resolveTaskName(state.env) };
    loaded = true;
  } else {
    throw unavailable();
  }
  return {
    identity,
    facts: { exists: true, enabled, loaded, stopped: state.runtime?.status === "stopped" },
  };
}
