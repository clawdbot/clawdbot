import { platform } from "node:os";
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
import { gatewayServiceCommandUsesInterruptedPackageRoot } from "./update-command-package-replay.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { gatewayServiceCommandUsesRoot } from "./update-command-service-plan.js";

/** Observations are evidence only. The caller retains its native lock and live
 * executor through inspection and the Recovery owner's exact-revision write.
 */
export async function readUpdateCommandNativeObservation(params: {
  record: Pick<UpdateRecoveryRecord, "runId" | "source" | "from"> & Partial<UpdateRecoveryRecord>;
  env: NodeJS.ProcessEnv;
  definitionPaths: readonly string[];
  assertCurrent: () => void;
  timeoutMs?: number;
  quiescingFailedCandidate?: true;
  /** Only a live source/executor owner may reload a checkpoint-bound unit definition. */
  inspectOwnedUnit?: () => void;
}): Promise<UpdateRecoveryNativeObservation> {
  const unavailable = () =>
    new UpdateCommandRecoveryPendingError("Original native-manager state cannot be verified.");
  const source = params.record.source;
  if (!source || source.profile === undefined) {
    throw unavailable();
  }
  // A failed start may leave a positively inspected systemd auto-restart job.
  // This proves only non-quiescence, never readiness or a stopped service.
  // Linux loadState reports is-enabled policy. Loaded-only command/runtime
  // reads below prove unit loading even after journaled suppression disables it.
  const autoRestarting = (value: GatewayServiceState) =>
    params.quiescingFailedCandidate === true &&
    Boolean(params.record.primaryFailure) &&
    Boolean(params.record.checkpoint) &&
    Boolean(params.record.nativeManager) &&
    params.record.effects?.some(
      (effect) =>
        effect.kind === "service-restart" &&
        effect.state === "intent" &&
        effect.runtime === "candidate",
    ) === true &&
    !params.record.terminal &&
    platform() === "linux" &&
    value.runtime?.status === "unknown" &&
    value.runtime.state === "activating" &&
    value.runtime.subState === "auto-restart" &&
    (value.runtime.pid === undefined || value.runtime.pid === 0) &&
    typeof value.runtime.systemd?.nRestarts === "number" &&
    Number.isInteger(value.runtime.systemd.nRestarts) &&
    value.runtime.systemd.nRestarts >= 0;
  const nativeIdentity = params.record.nativeManager?.identity;
  if (params.inspectOwnedUnit && (!params.record.checkpoint || !nativeIdentity)) {
    throw unavailable();
  }
  if (
    params.inspectOwnedUnit &&
    (nativeIdentity?.runId !== params.record.runId ||
      nativeIdentity.stateDir !== source.stateDir ||
      nativeIdentity.configPath !== source.configPath ||
      nativeIdentity.profile !== source.profile ||
      resolveStateDir(params.env) !== source.stateDir ||
      resolveConfigPath(params.env) !== source.configPath ||
      (params.env.OPENCLAW_PROFILE?.trim() || null) !== source.profile ||
      (nativeIdentity.platform === "linux" &&
        nativeIdentity.unitName !== `${resolveSystemdServiceName(params.env)}.service`))
  ) {
    throw unavailable();
  }
  const loadForInspection =
    params.inspectOwnedUnit &&
    platform() === "linux" &&
    nativeIdentity?.platform === "linux" &&
    nativeIdentity.scope === "user"
      ? { managerUid: nativeIdentity.uid, assertCurrent: params.inspectOwnedUnit }
      : undefined;
  params.assertCurrent();
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, {
    env: params.env,
    requireEffective: true,
    requireLoadedCommand: true,
    ...(loadForInspection ? { loadForInspection } : {}),
    timeoutMs: params.timeoutMs,
  });
  params.assertCurrent();
  if (
    !state.installed ||
    !state.command?.sourcePath ||
    state.loadState.status === "unknown" ||
    (!["running", "stopped"].includes(state.runtime?.status ?? "") && !autoRestarting(state)) ||
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
  let belongsToRoot = await gatewayServiceCommandUsesRoot({
    root: params.record.from.root,
    env: state.env,
    command: state.command,
  });
  params.assertCurrent();
  if (belongsToRoot === null && state.runtime?.status === "stopped") {
    belongsToRoot = await gatewayServiceCommandUsesInterruptedPackageRoot({
      record: params.record,
      command: state.command,
    });
    params.assertCurrent();
  }
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
    ...(loadForInspection ? { loadForInspection } : {}),
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
    autoRestart: autoRestarting(value)
      ? {
          state: value.runtime?.state,
          subState: value.runtime?.subState,
          restarts: value.runtime?.systemd?.nRestarts,
        }
      : undefined,
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
    ...(loadForInspection ? { loadForInspection } : {}),
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
  if (platform() === "darwin") {
    identity = {
      ...binding,
      platform: "darwin",
      domain: resolveLaunchAgentGuiDomain(),
      label: resolveLaunchAgentLabel(state.env),
    };
    loaded = state.loadState.status === "loaded";
  } else if (platform() === "linux") {
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
    // Ordinary inspection uses GetUnit; a live recovery owner may reload the
    // bound definition. Both paths verify effective properties and drained native
    // processes, independently of is-enabled policy and without starting it.
    identity = { ...binding, platform: "linux", scope: "user", unitName, uid: native.managerUid };
    loaded = true;
  } else if (platform() === "win32") {
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
