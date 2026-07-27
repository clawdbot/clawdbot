/**
 * Configured binding target lifecycle helpers.
 *
 * Ensures or resets stateful binding targets through registered target drivers.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
import {
  ensureStatefulTargetBuiltinsRegistered,
  isStatefulTargetBuiltinDriverId,
} from "./stateful-target-builtins.js";
import {
  getStatefulBindingTargetDriver,
  resolveStatefulBindingTargetBySessionKey,
  type StatefulBindingTargetResetResult,
} from "./stateful-target-drivers.js";

/**
 * Ensures the stateful target driver for a configured binding is ready to receive traffic.
 */
export async function ensureConfiguredBindingTargetReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.bindingResolution) {
    return { ok: true };
  }
  const driverId = params.bindingResolution.statefulTarget.driverId;
  let driver = getStatefulBindingTargetDriver(driverId);
  // Built-in drivers are registered lazily so normal channel startup does not load every
  // stateful target implementation before a binding actually needs one.
  if (!driver && isStatefulTargetBuiltinDriverId(driverId)) {
    await ensureStatefulTargetBuiltinsRegistered();
    driver = getStatefulBindingTargetDriver(driverId);
  }
  if (!driver) {
    return {
      ok: false,
      error: `Configured binding target driver unavailable: ${driverId}`,
    };
  }
  return await driver.ensureReady({
    cfg: params.cfg,
    bindingResolution: params.bindingResolution,
  });
}

/**
 * Resets a stateful configured binding target in place when its driver supports reset.
 */
export async function resetConfiguredBindingTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: "new" | "reset";
  commandSource?: string;
}): Promise<StatefulBindingTargetResetResult> {
  let resolved = resolveStatefulBindingTargetBySessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!resolved) {
    await ensureStatefulTargetBuiltinsRegistered();
    resolved = resolveStatefulBindingTargetBySessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
  }
  if (!resolved?.driver.resetInPlace) {
    // A missing reset hook is a valid skip, not a hard routing failure.
    return {
      ok: false,
      skipped: true,
    };
  }
  return await resolved.driver.resetInPlace({
    ...params,
    bindingTarget: resolved.bindingTarget,
  });
}
