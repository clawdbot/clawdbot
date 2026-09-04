/** systemd unit publication, installation, staging, and uninstall. */
import fs from "node:fs/promises";
import { resolveStateDir } from "../config/paths.js";
import {
  isUnresolvedShellReference,
  readStateDirDotEnvFromStateDir,
} from "../config/state-dir-dotenv.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayServiceDescription,
} from "./constants.js";
import { formatLine, writeFormattedLines } from "./output.js";
import {
  hasEnvironmentFileSource,
  hasInlineEnvironmentSource,
  isEnvironmentFileOnlySource,
  normalizeServiceEnvKey,
  normalizeServiceEnvKeys,
  readEnvironmentValueSource,
  readManagedServiceEnvKeysFromEnvironment,
} from "./service-managed-env.js";
import {
  hasGatewayServiceLauncherOverride,
  resolveManagedGatewayServiceCommand,
  type GatewayServiceEnv,
  type GatewayServiceEnvironmentValueSource,
  type GatewayServiceInstallArgs,
  type GatewayServiceManageArgs,
} from "./service-types.js";
import { withSystemdDefinitionMutation } from "./systemd-definition-mutation.js";
import {
  assertSystemdAvailable,
  disableSystemdUserUnitForRemoval,
  execSystemctlUser,
  isSystemdUnitMissingDetail,
  isSystemdUserScopeUnavailable,
  readSystemctlDetail,
  reloadSystemdUserManager,
} from "./systemd-exec.js";
import { assertNoSystemGatewayOwnership } from "./systemd-scope.js";
import {
  isNodeSystemdEnvironment,
  readSystemdEnvironmentFile,
  readSystemdServiceExecStart,
  resolveLegacyNodeSystemdEnvironmentFilePath,
  resolveSystemdEnvironmentFilePath,
  resolveSystemdServiceName,
  resolveSystemdUnitPath,
  serializeSystemdEnvironmentFile,
} from "./systemd-service-files.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignments,
  renderSystemdEnvAssignment,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

const SYSTEMD_GATEWAY_CREDENTIAL_KEYS = new Set([
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
]);

function restrictSystemdArtifactMode(mode: number | undefined): number {
  const ownerOnly = (mode ?? 0o600) & 0o700;
  return ownerOnly || 0o600;
}

function collectSystemdInlineManagedKeys(params: {
  environment?: GatewayServiceEnv;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}): Set<string> {
  const keys = readManagedServiceEnvKeysFromEnvironment(params.environment);
  for (const key of collectSystemdFileManagedKeys(params.environmentValueSources)) {
    keys.delete(key);
  }
  for (const [rawKey, value] of Object.entries(params.environment ?? {})) {
    // Clearing NODE_OPTIONS must also remove stale env-file flags that override inline values.
    if (typeof value !== "string" || (!value.trim() && rawKey !== "NODE_OPTIONS")) {
      continue;
    }
    const key = normalizeServiceEnvKey(rawKey);
    if (!key) {
      continue;
    }
    const source = readEnvironmentValueSource(params.environmentValueSources, rawKey);
    if (hasInlineEnvironmentSource(source) && !hasEnvironmentFileSource(source)) {
      keys.add(key);
    }
  }
  return keys;
}

function collectSystemdFileManagedKeys(
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>,
): Set<string> {
  return normalizeServiceEnvKeys(
    Object.entries(environmentValueSources ?? {})
      .filter(([, source]) => isEnvironmentFileOnlySource(source))
      .map(([key]) => key),
  );
}

function collectSystemdFileBackedEnvironment(params: {
  environment?: GatewayServiceEnv;
  fileManagedKeys: ReadonlySet<string>;
}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(params.environment ?? {})) {
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      continue;
    }
    const key = normalizeServiceEnvKey(rawKey);
    if (key && params.fileManagedKeys.has(key) && !isUnresolvedShellReference(rawValue)) {
      environment[rawKey] = rawValue;
    }
  }
  return environment;
}

function removeSystemdInlineEnvironmentKeys(content: string, keys: ReadonlySet<string>): string {
  const sanitizedLines: string[] = [];
  for (const rawLine of splitSystemdLogicalLines(content)) {
    const line = rawLine.trim();
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== "Environment") {
      sanitizedLines.push(rawLine);
      continue;
    }
    const assignments = parseSystemdEnvAssignments(line.slice(separator + 1).trim());
    const keptAssignments = assignments.filter(({ key }) => {
      const normalizedKey = normalizeServiceEnvKey(key);
      return !normalizedKey || !keys.has(normalizedKey);
    });
    if (keptAssignments.length === assignments.length) {
      sanitizedLines.push(rawLine);
      continue;
    }
    if (keptAssignments.length === 0) {
      continue;
    }
    const leadingWhitespace = rawLine.match(/^\s*/)?.[0] ?? "";
    sanitizedLines.push(
      `${leadingWhitespace}Environment=${keptAssignments
        .map(({ key, value }) => renderSystemdEnvAssignment(key, value))
        .join(" ")}`,
    );
  }
  return sanitizedLines.join("\n");
}

function sanitizeSystemdUnitBackupContent(params: {
  content: string;
  fileManagedKeys: ReadonlySet<string>;
}): string {
  // Gateway credentials are never useful in a recovery artifact. File-managed
  // values are also omitted after OpenClaw moves them to the generated env file.
  return removeSystemdInlineEnvironmentKeys(
    params.content,
    new Set([...params.fileManagedKeys, ...SYSTEMD_GATEWAY_CREDENTIAL_KEYS]),
  );
}

function removeLegacyGatewayVersionMetadata(content: string): string {
  const description =
    /^Description=OpenClaw Gateway \((?:(profile: [^,)\r\n]+), )?v([^)\r\n]+)\)$/mu.exec(content);
  if (!description) {
    return content;
  }
  const inlineEnvironment = new Map<string, string>();
  let inServiceSection = false;
  for (const rawLine of splitSystemdLogicalLines(content)) {
    const line = rawLine.trim();
    if (/^\[[^\]]+\]$/u.test(line)) {
      inServiceSection = line === "[Service]";
      continue;
    }
    if (!inServiceSection || !line.startsWith("Environment=")) {
      continue;
    }
    const rawAssignments = line.slice("Environment=".length).trim();
    if (!rawAssignments) {
      inlineEnvironment.clear();
      continue;
    }
    for (const assignment of parseSystemdEnvAssignments(rawAssignments)) {
      inlineEnvironment.set(assignment.key, assignment.value);
    }
  }
  if (
    inlineEnvironment.get("OPENCLAW_SERVICE_MARKER") !== GATEWAY_SERVICE_MARKER ||
    inlineEnvironment.get("OPENCLAW_SERVICE_KIND") !== GATEWAY_SERVICE_KIND ||
    inlineEnvironment.get("OPENCLAW_SERVICE_VERSION") !== description[2]
  ) {
    return content;
  }
  const replacement = description[1]
    ? `Description=OpenClaw Gateway (${description[1]})`
    : "Description=OpenClaw Gateway";
  const refreshed =
    content.slice(0, description.index) +
    replacement +
    content.slice(description.index + description[0].length);
  return removeSystemdInlineEnvironmentKeys(refreshed, new Set(["OPENCLAW_SERVICE_VERSION"]));
}

/** Removes obsolete install-time version stamps without restarting the service. */
export async function refreshLegacySystemdServiceMetadata(
  env: GatewayServiceEnv,
  timeoutMs: number,
): Promise<boolean> {
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);
  const remainingTimeoutMs = () => Math.max(1, deadlineAt - Date.now());
  const unitPath = resolveSystemdUnitPath(env);
  const current = await fs.readFile(unitPath, "utf8").catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (current === null || removeLegacyGatewayVersionMetadata(current) === current) {
    return false;
  }

  await assertNoSystemGatewayOwnership(env, remainingTimeoutMs());
  return await withSystemdDefinitionMutation(
    env,
    env,
    async (mutation) => {
      const snapshot = mutation.snapshots.get(unitPath) ?? null;
      if (!snapshot) {
        return false;
      }
      const previous = snapshot.contents.toString("utf8");
      const refreshed = removeLegacyGatewayVersionMetadata(previous);
      if (refreshed === previous) {
        return false;
      }
      // Ownership can change while the mutation snapshot is prepared. Recheck around
      // publication and restore if a system unit takes ownership during that window.
      await assertNoSystemGatewayOwnership(env, remainingTimeoutMs());
      await mutation.publish(unitPath, refreshed, snapshot.mode || 0o644);
      try {
        await assertNoSystemGatewayOwnership(env, remainingTimeoutMs());
        await reloadSystemdUserManager(env, remainingTimeoutMs());
      } catch (error) {
        await mutation.restore(unitPath, snapshot);
        throw error;
      }
      return true;
    },
    { timeoutMs: remainingTimeoutMs() },
  );
}

async function writeSystemdUnit({
  env,
  programArguments,
  workingDirectory,
  environment,
  environmentValueSources,
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{ unitPath: string; backedUp: boolean }> {
  await assertSystemdAvailable(env);
  await assertNoSystemGatewayOwnership(env);

  const unitPath = resolveSystemdUnitPath(env);
  return await withSystemdDefinitionMutation(env, environment ?? env, async (mutation) => {
    const priorManagedKeys = readManagedServiceEnvKeysFromEnvironment(
      resolveManagedGatewayServiceCommand(await readSystemdServiceExecStart(env))?.environment,
    );
    const stateDir = resolveStateDir({ ...env, ...environment });
    const environmentFilePath = resolveSystemdEnvironmentFilePath({ stateDir, environment });
    const environmentFileSnapshot = isNodeSystemdEnvironment(env)
      ? undefined
      : (mutation.snapshots.get(environmentFilePath) ?? null);
    const existingUnit = mutation.snapshots.get(unitPath) ?? null;
    const backupPath = `${unitPath}.bak`;
    const existingBackup = mutation.snapshots.get(backupPath) ?? null;
    const { entries: stateDirDotEnvEntries, skippedShellReferenceKeys } =
      readStateDirDotEnvFromStateDir(stateDir);
    const stateDirDotEnvVars = new Map(
      Object.entries(stateDirDotEnvEntries).filter(([key, value]) => {
        const inlineValue = environment?.[key];
        return typeof inlineValue !== "string" || inlineValue.trim() === value.trim();
      }),
    );
    const inlineManagedKeys = collectSystemdInlineManagedKeys({
      environment,
      environmentValueSources,
    });
    const fileManagedKeys = collectSystemdFileManagedKeys(environmentValueSources);
    const existingEnvironment = await readSystemdGatewayEnvironmentFiles(stateDir, environment);

    const backupSource = existingUnit ?? existingBackup;
    if (backupSource) {
      await mutation.publish(
        backupPath,
        sanitizeSystemdUnitBackupContent({
          content: backupSource.contents.toString("utf8"),
          fileManagedKeys,
        }),
        restrictSystemdArtifactMode(backupSource.mode),
      );
    }
    try {
      const incoming = collectSystemdFileBackedEnvironment({ environment, fileManagedKeys });
      for (const [key, value] of Object.entries(incoming)) {
        if (/[\r\n]/.test(value)) {
          throw new Error(
            `state-dir .env contains a multiline value for ${key}; systemd EnvironmentFile values must be single-line`,
          );
        }
      }
      // Deleted managed values remain managed. Drop their stale file copies so
      // EnvironmentFile precedence cannot shadow inline values or runtime .env edits.
      const managedKeysToDrop = normalizeServiceEnvKeys([
        ...inlineManagedKeys,
        ...fileManagedKeys,
        ...priorManagedKeys,
        ...stateDirDotEnvVars.keys(),
        ...skippedShellReferenceKeys,
      ]);
      const { existing, literalShellReferenceKeys } = existingEnvironment;
      const operatorOnly = Object.fromEntries(
        Object.entries(existing).filter(([key, value]) => {
          const normalized = normalizeServiceEnvKey(key);
          if (normalized && managedKeysToDrop.has(normalized)) {
            return false;
          }
          // Quoted/escaped $VAR is operator intent; bare references can be stale
          // values copied from the state-dir dotenv file.
          return literalShellReferenceKeys.has(key) || !isUnresolvedShellReference(value);
        }),
      );
      const merged = { ...operatorOnly, ...incoming };
      const hasGeneratedValues = Object.keys(merged).length > 0;
      const environmentKeys = normalizeServiceEnvKeys(Object.keys(merged));
      // Keep an existing empty file readable until the manager drops its reference.
      if (hasGeneratedValues || mutation.snapshots.has(environmentFilePath)) {
        const content = hasGeneratedValues ? `${serializeSystemdEnvironmentFile(merged)}\n` : "";
        await mutation.publish(environmentFilePath, content, 0o600);
      }
      const environmentSansDotEnvEntries = Object.fromEntries(
        Object.entries(environment ?? {}).filter(([key, value]) => {
          if (typeof value !== "string") {
            return false;
          }
          const source = readEnvironmentValueSource(environmentValueSources, key);
          const normalized = normalizeServiceEnvKey(key);
          const generated =
            normalized && environmentKeys.has(normalized) && !inlineManagedKeys.has(normalized);
          return (
            !(hasEnvironmentFileSource(source) && isUnresolvedShellReference(value)) &&
            !generated &&
            value.trim() !== stateDirDotEnvVars.get(key)?.trim()
          );
        }),
      );
      const unit = buildSystemdUnit({
        description: resolveGatewayServiceDescription({ env, description }),
        programArguments,
        workingDirectory,
        environment: environmentSansDotEnvEntries,
        environmentFiles: hasGeneratedValues ? [environmentFilePath] : [],
      });
      await assertNoSystemGatewayOwnership(env);
      await mutation.publish(unitPath, unit, restrictSystemdArtifactMode(existingUnit?.mode));
      try {
        await assertNoSystemGatewayOwnership(env);
      } catch (ownershipError) {
        await mutation.restore(unitPath, existingUnit);
        throw ownershipError;
      }
    } catch (error) {
      let rollbackError: unknown;
      try {
        await mutation.restore(backupPath, existingBackup);
      } catch (cause) {
        rollbackError = cause;
      }
      if (environmentFileSnapshot !== undefined) {
        try {
          await mutation.restore(environmentFilePath, environmentFileSnapshot);
        } catch (cause) {
          rollbackError ??= cause;
        }
      }
      if (rollbackError) {
        const failureDetail = error instanceof Error ? error.message : String(error);
        const rollbackDetail =
          rollbackError instanceof Error ? rollbackError.message : "unknown rollback error";
        throw new Error(`${failureDetail}\nSystemd rollback failed: ${rollbackDetail}`, {
          cause: error,
        });
      }
      throw error;
    }
    return { unitPath, backedUp: existingUnit !== null };
  });
}

async function readSystemdGatewayEnvironmentFiles(
  stateDir: string,
  environment?: GatewayServiceEnv,
) {
  const existing: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  for (const sourcePath of [
    resolveLegacyNodeSystemdEnvironmentFilePath({ stateDir, environment }),
    resolveSystemdEnvironmentFilePath({ stateDir, environment }),
  ]) {
    if (!sourcePath) {
      continue;
    }
    try {
      const fromFile = await readSystemdEnvironmentFile(sourcePath);
      for (const [key, value] of Object.entries(fromFile.environment)) {
        existing[key] = value;
        literalShellReferenceKeys.delete(key);
        if (fromFile.literalShellReferenceKeys.has(key)) {
          literalShellReferenceKeys.add(key);
        }
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return { existing, literalShellReferenceKeys };
}

async function removeNodeSystemdManagedEnvironmentKeys(env: GatewayServiceEnv): Promise<void> {
  if (!isNodeSystemdEnvironment(env)) {
    return;
  }
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const envFilePath = resolveSystemdEnvironmentFilePath({
    stateDir,
    environment: env,
  });
  let existingFile: Awaited<ReturnType<typeof readSystemdEnvironmentFile>>;
  try {
    existingFile = await readSystemdEnvironmentFile(envFilePath);
  } catch {
    return;
  }
  const managedKeys = new Set(["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]);
  const remaining = Object.fromEntries(
    Object.entries(existingFile.environment).filter(([key, value]) => {
      const normalized = normalizeServiceEnvKey(key);
      if (normalized && managedKeys.has(normalized)) {
        return false;
      }
      return existingFile.literalShellReferenceKeys.has(key) || !isUnresolvedShellReference(value);
    }),
  );
  if (Object.keys(remaining).length === 0) {
    await fs.rm(envFilePath, { force: true });
    return;
  }
  const content = serializeSystemdEnvironmentFile(remaining);
  await fs.writeFile(envFilePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envFilePath, 0o600);
}

function reportSystemdServicePublication(
  stdout: NodeJS.WritableStream,
  label: string,
  unitPath: string,
  backedUp: boolean,
): void {
  const lines = [{ label, value: unitPath }];
  if (backedUp) {
    lines.push({ label: "Previous unit backed up to", value: `${unitPath}.bak` });
  }
  writeFormattedLines(stdout, lines, { leadingBlankLine: true });
}

export async function stageSystemdService({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ unitPath: string }> {
  const { unitPath, backedUp } = await writeSystemdUnit(args);
  reportSystemdServicePublication(stdout, "Staged systemd service", unitPath, backedUp);
  return { unitPath };
}

async function activateSystemdService(params: { env: GatewayServiceEnv }) {
  const unitName = `${resolveSystemdServiceName(params.env)}.service`;
  // A system unit may appear after publication. Refuse before the user manager
  // can load a second supervisor for the same gateway name.
  await assertNoSystemGatewayOwnership(params.env);
  const runActivation = async (
    action: "daemon-reload" | "enable" | "restart",
    retryMissing = true,
  ): Promise<void> => {
    const args = action === "daemon-reload" ? [action] : [action, unitName];
    const result = await execSystemctlUser(params.env, args);
    if (result.code === 0) {
      return;
    }
    const detail = readSystemctlDetail(result);
    if (
      action !== "daemon-reload" &&
      retryMissing &&
      result.termination === "exit" &&
      isSystemdUnitMissingDetail(detail)
    ) {
      await runActivation("daemon-reload");
      return await runActivation(action, false);
    }
    if (isSystemdUserScopeUnavailable(detail)) {
      throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
    }
    throw new Error(`systemctl ${action} failed: ${detail || "unknown error"}`.trim());
  };
  for (const action of ["daemon-reload", "enable", "restart"] as const) {
    await runActivation(action);
  }
}

export async function installSystemdService(
  args: GatewayServiceInstallArgs,
): Promise<{ unitPath: string }> {
  const { unitPath, backedUp } = await writeSystemdUnit(args);
  await activateSystemdService({ env: args.env });
  if (
    args.warn &&
    hasGatewayServiceLauncherOverride(await readSystemdServiceExecStart(args.env).catch(() => null))
  ) {
    args.warn(
      "Systemd drop-in overrides the managed service command or working directory; inspect, update, or remove the drop-in because reinstalling the base unit does not change the effective launcher.",
    );
  }
  reportSystemdServicePublication(args.stdout, "Installed systemd service", unitPath, backedUp);
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSystemdAvailable(env);
  const unitName = `${resolveSystemdServiceName(env)}.service`;
  await disableSystemdUserUnitForRemoval(env, unitName);

  const unitPath = resolveSystemdUnitPath(env);
  let removed = false;
  try {
    await fs.unlink(unitPath);
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Unit file was already absent; still clean generated node env state below.
  }
  await fs.unlink(`${unitPath}.bak`).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  });
  await removeNodeSystemdManagedEnvironmentKeys(env);
  if (removed) {
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } else {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}
