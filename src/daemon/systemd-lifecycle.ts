/** systemd start, stop, restart, and obsolete-unit removal. */
import fs from "node:fs/promises";
import { LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES } from "./constants.js";
import { formatLine } from "./output.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
} from "./service-types.js";
import {
  assertSystemdAvailable,
  disableSystemdUserUnitForRemoval,
  execSystemctl,
  execSystemctlUser,
  isSystemctlAvailable,
  reloadSystemdUserManager,
} from "./systemd-exec.js";
import {
  assertNoSystemGatewayOwnership,
  findInstalledSystemdGatewayScope,
} from "./systemd-scope.js";
import {
  resolveSystemdServiceName,
  resolveSystemdUnitPath,
  resolveSystemdUnitPathForName,
} from "./systemd-service-files.js";

function isRunningAsRoot(): boolean {
  if (typeof process.geteuid === "function") {
    try {
      return process.geteuid() === 0;
    } catch {
      return false;
    }
  }
  return false;
}

async function runSystemdServiceAction(params: {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  action: "start" | "stop" | "restart";
  label: string;
  onMutation?: () => void;
}) {
  const env = params.env ?? process.env;
  const installed = await findInstalledSystemdGatewayScope(env);
  const unitName = installed?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  let runSystemctl: (args: string[]) => ReturnType<typeof execSystemctl>;
  if (installed?.scope === "system") {
    if (!isRunningAsRoot()) {
      throw new Error(
        `${unitName} is a system-scope unit (${installed.unitPath}); run \`sudo systemctl ${params.action} ${unitName}\` to ${params.action} it`,
      );
    }
    runSystemctl = (args) => execSystemctl(args, env);
  } else {
    await assertSystemdAvailable(env);
    if (params.action !== "stop") {
      await assertNoSystemGatewayOwnership(env);
    }
    runSystemctl = (args) => execSystemctlUser(env, args);
  }
  if (params.action !== "stop") {
    // Clear crash-loop start-limit latches only after scope ownership is proven;
    // otherwise resetting a conflicting manager could mutate the wrong service.
    await runSystemctl(["reset-failed", unitName]);
  }
  const res = await runSystemctl([params.action, unitName]);
  if (res.code !== 0) {
    throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
  }
  params.onMutation?.();
  params.stdout.write(`${formatLine(params.label, unitName)}\n`);
}

export async function startSystemdService({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<void> {
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  await runSystemdServiceAction({
    stdout,
    env,
    action: "start",
    label: "Started systemd service",
    onMutation: () => reportMutation("systemctl-start"),
  });
}

export async function stopSystemdService({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<void> {
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  await runSystemdServiceAction({
    stdout,
    env,
    action: "stop",
    label: "Stopped systemd service",
    onMutation: () => reportMutation("systemctl-stop"),
  });
}

export async function restartSystemdService({
  stdout,
  env,
  onMutation,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  await runSystemdServiceAction({
    stdout,
    env,
    action: "restart",
    label: "Restarted systemd service",
    onMutation: () => reportMutation("systemctl-restart"),
  });
  return { outcome: "completed" };
}

type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function findLegacySystemdUnits(env: GatewayServiceEnv): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable(env);
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctlUser(env, ["is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) {
    return units;
  }

  const systemctlAvailable = await isSystemctlAvailable(env);
  let removedAny = false;
  for (const unit of units) {
    if (systemctlAvailable) {
      await disableSystemdUserUnitForRemoval(env, `${unit.name}.service`);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      removedAny = true;
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }
  if (systemctlAvailable && removedAny) {
    await reloadSystemdUserManager(env);
  }

  return units;
}

type UninstallUserSystemdGatewayUnitResult = {
  unitName: string;
  unitPath: string;
  removed: boolean;
  /**
   * False when systemctl could not disable/stop the unit. Deleting the unit
   * file alone does not evict an already-loaded unit, so callers must not
   * claim the conflict is resolved on a file-only removal.
   */
  disabled: boolean;
};

/**
 * Removes the canonical *user-scope* gateway unit, leaving any system-scope
 * unit untouched. Used by doctor to resolve a `dueling` installation by
 * dropping the redundant user-scope leftover (issue #79375). Removing a unit
 * under `$HOME` needs no root, unlike the system-scope unit.
 */
export async function uninstallUserSystemdGatewayUnit({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<UninstallUserSystemdGatewayUnitResult> {
  const unitName = `${resolveSystemdServiceName(env)}.service`;
  const unitPath = resolveSystemdUnitPath(env);
  let disabled = false;
  if (await isSystemctlAvailable(env)) {
    await disableSystemdUserUnitForRemoval(env, unitName);
    disabled = true;
  } else {
    stdout.write(
      `systemctl unavailable; removing unit file only: ${unitName}. A loaded unit keeps running until systemd reloads.\n`,
    );
  }
  let removed = false;
  try {
    await fs.unlink(unitPath);
    removed = true;
    stdout.write(`${formatLine("Removed user-scope systemd service", unitPath)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    stdout.write(`User-scope systemd unit not found at ${unitPath}\n`);
  }
  // The manager keeps a deleted unit's definition loaded until it reloads, so
  // without this the unit stays startable while the detector reports it gone.
  if (removed && disabled) {
    await reloadSystemdUserManager(env);
  }
  return { unitName, unitPath, removed, disabled };
}
