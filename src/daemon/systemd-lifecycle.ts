/** systemd start, stop, restart, and obsolete-unit removal. */
import fs, { constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
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
  /** Archive destination, or undefined when there was no unit file to move. */
  archivedPath: string | undefined;
  /**
   * False when systemctl could not disable/stop the unit. Deleting the unit
   * file alone does not evict an already-loaded unit, so callers must not
   * claim the conflict is resolved on a file-only removal.
   */
  disabled: boolean;
};

/** Timestamped archive directory for units doctor moves out of the way. */
function resolveSystemdUnitArchiveDir(env: GatewayServiceEnv): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(resolveStateDir(env as NodeJS.ProcessEnv), "backups", "systemd-units", day);
}

/**
 * Copies to `baseTarget`, or a numbered sibling if something is already there.
 * The archive directory is keyed by day, not by run, so a second repair the
 * same day (or any pre-existing file at that exact path) would otherwise let
 * `copyFile` silently replace an earlier operator backup — the exact data
 * loss this archive-instead-of-delete path exists to prevent (#116130).
 */
async function copyToUniqueArchiveTarget(sourcePath: string, baseTarget: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const target = attempt === 0 ? baseTarget : `${baseTarget}.${attempt}`;
    try {
      await fs.copyFile(sourcePath, target, fsConstants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

/**
 * Archives the canonical *user-scope* gateway unit, leaving any system-scope
 * unit untouched. Used by doctor to resolve a `dueling` installation by
 * clearing the redundant user-scope leftover (issue #79375). The unit is moved,
 * not unlinked, so operator edits (custom `ExecStart`, `Environment=`, limits)
 * survive a wrong ownership guess and can be restored with `cp` (issue #116130).
 * Touching a unit under `$HOME` needs no root, unlike the system-scope unit.
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
      `systemctl unavailable; archiving unit file only: ${unitName}. A loaded unit keeps running until systemd reloads.\n`,
    );
  }
  const archiveTarget = path.join(resolveSystemdUnitArchiveDir(env), unitName);
  let archivedPath: string | undefined;
  try {
    // Archive dir first, so a missing destination cannot raise the ENOENT that
    // means "no unit file here"; copy before unlink, so a cross-filesystem
    // state dir or a failed write leaves the operator's unit in place.
    await fs.mkdir(path.dirname(archiveTarget), { recursive: true, mode: 0o700 });
    archivedPath = await copyToUniqueArchiveTarget(unitPath, archiveTarget);
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Archived user-scope systemd service", archivedPath)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    stdout.write(`User-scope systemd unit not found at ${unitPath}\n`);
  }
  // The manager keeps a deleted unit's definition loaded until it reloads, so
  // without this the unit stays startable while the detector reports it gone.
  if (archivedPath && disabled) {
    await reloadSystemdUserManager(env);
  }
  return { unitName, unitPath, archivedPath, disabled };
}
