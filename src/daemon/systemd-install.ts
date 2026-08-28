/** systemd unit publication, installation, staging, and uninstall. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  isUnresolvedShellReference,
  readStateDirDotEnvFromStateDir,
} from "../config/state-dir-dotenv.js";
import { resolveGatewayServiceDescription } from "./constants.js";
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
import {
  assertSystemdAvailable,
  disableSystemdUserUnitForRemoval,
  execSystemctlUser,
  isSystemdUnitMissingDetail,
  isSystemdUserScopeUnavailable,
  readSystemctlDetail,
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
} from "./systemd-unit.js";

function collectSystemdInlineManagedKeys(params: {
  environment?: GatewayServiceEnv;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}): Set<string> {
  const keys = readManagedServiceEnvKeysFromEnvironment(params.environment);
  for (const key of collectSystemdFileManagedKeys({
    environmentValueSources: params.environmentValueSources,
  })) {
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

function collectSystemdFileManagedKeys(params: {
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}): Set<string> {
  const keys = new Set<string>();
  for (const [rawKey, source] of Object.entries(params.environmentValueSources ?? {})) {
    const key = normalizeServiceEnvKey(rawKey);
    if (key && isEnvironmentFileOnlySource(source)) {
      keys.add(key);
    }
  }
  return keys;
}

function collectSystemdFileBackedEnvironment(params: {
  environment?: GatewayServiceEnv;
  fileManagedKeys: ReadonlySet<string>;
}): Record<string, string> {
  if (params.fileManagedKeys.size === 0) {
    return {};
  }
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

function sanitizeSystemdUnitBackupContent(params: {
  content: string;
  fileManagedKeys: ReadonlySet<string>;
}): string {
  if (params.fileManagedKeys.size === 0) {
    return params.content;
  }
  // Backups should not retain file-managed secrets that OpenClaw moved into the
  // generated EnvironmentFile during this rewrite.
  const sanitizedLines: string[] = [];
  for (const rawLine of params.content.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("Environment=")) {
      sanitizedLines.push(rawLine);
      continue;
    }
    const assignments = parseSystemdEnvAssignments(line.slice("Environment=".length).trim());
    if (assignments.length === 0) {
      sanitizedLines.push(rawLine);
      continue;
    }
    const keptAssignments = assignments.filter(({ key }) => {
      const normalizedKey = normalizeServiceEnvKey(key);
      return !normalizedKey || !params.fileManagedKeys.has(normalizedKey);
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
  const priorManagedKeys = readManagedServiceEnvKeysFromEnvironment(
    resolveManagedGatewayServiceCommand(await readSystemdServiceExecStart(env))?.environment,
  );
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await assertSystemdManagedPathIsNotSymlink(unitPath);
  const fileManagedKeys = collectSystemdFileManagedKeys({
    environmentValueSources,
  });

  // Preserve user customizations: back up existing unit file before overwriting.
  let backedUp = false;
  try {
    const backupPath = `${unitPath}.bak`;
    const existingUnit = await fs.readFile(unitPath, "utf8");
    const existingStat = await fs.stat(unitPath);
    const backupMode = existingStat.mode & 0o777 || 0o600;
    const backupUnit = sanitizeSystemdUnitBackupContent({
      content: existingUnit,
      fileManagedKeys,
    });
    await fs.writeFile(backupPath, backupUnit, { encoding: "utf8", mode: backupMode });
    await fs.chmod(backupPath, backupMode);
    backedUp = true;
  } catch {
    // File does not exist yet — nothing to back up.
  }

  const serviceDescription = resolveGatewayServiceDescription({ env, description });
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const { entries: stateDirDotEnvEntries, skippedShellReferenceKeys } =
    readStateDirDotEnvFromStateDir(stateDir);
  const stateDirDotEnvVars = Object.fromEntries(
    Object.entries(stateDirDotEnvEntries).filter(([key, value]) => {
      const inlineValue = environment?.[key];
      if (typeof inlineValue !== "string") {
        return true;
      }
      return inlineValue.trim() === value.trim();
    }),
  );
  const inlineManagedKeys = collectSystemdInlineManagedKeys({
    environment,
    environmentValueSources,
  });
  const environmentFilePath = resolveSystemdEnvironmentFilePath({
    stateDir,
    environment,
  });
  const environmentFileSnapshot = isNodeSystemdEnvironment(env)
    ? undefined
    : await readSystemdFileSnapshot(environmentFilePath);
  try {
    const environmentFileResult = await writeSystemdGatewayEnvironmentFile({
      stateDir,
      stateDirDotEnvKeys: Object.keys(stateDirDotEnvVars),
      priorManagedKeys,
      inlineManagedKeys,
      fileManagedKeys,
      skippedManagedKeys: skippedShellReferenceKeys,
      fileBackedEnvironment: collectSystemdFileBackedEnvironment({
        environment,
        fileManagedKeys,
      }),
      environment,
    });
    const environmentSansDotEnvEntries = Object.fromEntries(
      Object.entries(environment ?? {}).filter(([key, value]) => {
        if (typeof value !== "string") {
          return false;
        }
        const source = readEnvironmentValueSource(environmentValueSources, key);
        if (hasEnvironmentFileSource(source) && isUnresolvedShellReference(value)) {
          return false;
        }
        const normalizedKey = normalizeServiceEnvKey(key);
        if (
          normalizedKey &&
          environmentFileResult.environmentKeys.has(normalizedKey) &&
          !inlineManagedKeys.has(normalizedKey)
        ) {
          return false;
        }
        const stateDirValue = stateDirDotEnvVars[key];
        if (typeof stateDirValue !== "string") {
          return true;
        }
        return value.trim() !== stateDirValue.trim();
      }),
    );
    const unit = buildSystemdUnit({
      description: serviceDescription,
      programArguments,
      workingDirectory,
      environment: environmentSansDotEnvEntries,
      environmentFiles: environmentFileResult.environmentFiles,
    });
    await publishSystemdUnit({ env, unitPath, contents: unit });
  } catch (error) {
    if (environmentFileSnapshot !== undefined) {
      try {
        await restoreSystemdFileSnapshot(environmentFilePath, environmentFileSnapshot);
      } catch (rollbackError) {
        const failureDetail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${failureDetail}\nThe previous systemd environment file at ${environmentFilePath} could not be restored.`,
          { cause: rollbackError },
        );
      }
    }
    throw error;
  }
  return { unitPath, backedUp };
}

type SystemdFileSnapshot = { contents: Buffer; mode: number } | null;

async function assertSystemdManagedPathIsNotSymlink(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to rewrite symlinked managed systemd file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readSystemdFileSnapshot(filePath: string): Promise<SystemdFileSnapshot> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to rewrite symlinked managed systemd file: ${filePath}`);
    }
    const contents = await fs.readFile(filePath);
    return { contents, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function restoreSystemdFileSnapshot(
  filePath: string,
  snapshot: SystemdFileSnapshot,
): Promise<void> {
  if (snapshot === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const rollbackPath = `${filePath}.openclaw-${randomUUID()}.rollback`;
  try {
    await fs.writeFile(rollbackPath, snapshot.contents, {
      flag: "wx",
      mode: snapshot.mode,
    });
    await fs.rename(rollbackPath, filePath);
  } finally {
    await fs.unlink(rollbackPath).catch(() => undefined);
  }
}

async function publishSystemdUnit(params: {
  env: GatewayServiceEnv;
  unitPath: string;
  contents: string;
}): Promise<void> {
  const previous = await readSystemdFileSnapshot(params.unitPath);
  const temporaryPath = `${params.unitPath}.openclaw-${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, params.contents, {
    encoding: "utf8",
    flag: "wx",
    mode: previous?.mode ?? 0o644,
  });
  try {
    // systemd ignores the temporary suffix, so this is the last ownership check
    // before the canonical user unit becomes discoverable.
    await assertNoSystemGatewayOwnership(params.env);
    await fs.rename(temporaryPath, params.unitPath);
    try {
      await assertNoSystemGatewayOwnership(params.env);
    } catch (ownershipError) {
      try {
        await restoreSystemdFileSnapshot(params.unitPath, previous);
      } catch (rollbackError) {
        const ownershipDetail =
          ownershipError instanceof Error ? ownershipError.message : String(ownershipError);
        throw new Error(
          `${ownershipDetail}\nThe previous user systemd unit at ${params.unitPath} could not be restored.`,
          { cause: rollbackError },
        );
      }
      throw ownershipError;
    }
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function writeSystemdGatewayEnvironmentFile(params: {
  stateDir: string;
  /** Keys loaded by the Gateway directly from the state-dir .env. They must be removed from
   *  generated files so a supervisor restart cannot shadow a later .env edit. */
  stateDirDotEnvKeys?: Iterable<string>;
  /** Keys owned by the previously installed service. Preserve the prior ownership record so
   *  deleting a managed dotenv key cannot reclassify its stale file value as operator-owned. */
  priorManagedKeys?: Iterable<string>;
  /** OpenClaw-managed keys that must not be preserved from an old env file; stale file values
   *  would override fresh inline Environment= entries because EnvironmentFile takes precedence. */
  inlineManagedKeys?: ReadonlySet<string>;
  /** File-managed keys that should be written from current environment values or removed when absent. */
  fileManagedKeys?: ReadonlySet<string>;
  /** State-dir .env keys OpenClaw previously managed but is now skipping (unresolved shell
   *  references). A prior re-stage may have written a stale literal value for them; drop it so
   *  the regenerated env file no longer carries the obsolete reference. */
  skippedManagedKeys?: Iterable<string>;
  fileBackedEnvironment?: Record<string, string>;
  environment?: GatewayServiceEnv;
}): Promise<{ environmentFiles: string[]; environmentKeys: Set<string> }> {
  const incoming = { ...params.fileBackedEnvironment };
  for (const [key, value] of Object.entries(incoming)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(
        `state-dir .env contains a multiline value for ${key}; systemd EnvironmentFile values must be single-line`,
      );
    }
  }
  const envFilePath = resolveSystemdEnvironmentFilePath({
    stateDir: params.stateDir,
    environment: params.environment,
  });

  // Read existing env files first so we can preserve operator-added secrets
  // (e.g. provider API keys) across upgrades and re-stages. Node units used
  // to share gateway.systemd.env, so migrate those entries into node.systemd.env.
  // OpenClaw-managed keys (identified by inlineManagedKeys) are excluded: a stale
  // file copy would override the fresh inline Environment= value because systemd's
  // EnvironmentFile takes precedence over inline Environment= directives.
  const existing: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  const legacyNodeEnvFilePath = resolveLegacyNodeSystemdEnvironmentFilePath({
    stateDir: params.stateDir,
    environment: params.environment,
  });
  for (const sourceEnvFilePath of [legacyNodeEnvFilePath, envFilePath]) {
    if (!sourceEnvFilePath) {
      continue;
    }
    try {
      const fromFile = await readSystemdEnvironmentFile(sourceEnvFilePath);
      for (const [key, value] of Object.entries(fromFile.environment)) {
        existing[key] = value;
        if (fromFile.literalShellReferenceKeys.has(key)) {
          literalShellReferenceKeys.add(key);
        } else {
          literalShellReferenceKeys.delete(key);
        }
      }
    } catch {
      // File does not exist yet — nothing to preserve.
    }
  }
  const managedKeysToDrop = normalizeServiceEnvKeys([
    ...(params.inlineManagedKeys ?? []),
    ...(params.fileManagedKeys ?? []),
    ...(params.priorManagedKeys ?? []),
    ...(params.stateDirDotEnvKeys ?? []),
    ...(params.skippedManagedKeys ?? []),
  ]);
  const operatorOnly = Object.fromEntries(
    Object.entries(existing).filter(([key, value]) => {
      const normalized = normalizeServiceEnvKey(key);
      if (normalized && managedKeysToDrop.has(normalized)) {
        return false;
      }
      // Quoting or escaping `$VAR` records operator intent; bare references can
      // still be stale values copied from the state-dir dotenv file.
      return literalShellReferenceKeys.has(key) || !isUnresolvedShellReference(value);
    }),
  );
  const merged = { ...operatorOnly, ...incoming };
  const environmentKeys = normalizeServiceEnvKeys(Object.keys(merged));

  // If the merged result is empty there is nothing to write and no file needed.
  if (Object.keys(merged).length === 0) {
    await fs.rm(envFilePath, { force: true }).catch(() => undefined);
    return { environmentFiles: [], environmentKeys };
  }

  const content = serializeSystemdEnvironmentFile(merged);
  await fs.mkdir(path.dirname(envFilePath), { recursive: true });
  await fs.writeFile(envFilePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envFilePath, 0o600);
  return { environmentFiles: [envFilePath], environmentKeys };
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

export async function stageSystemdService({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ unitPath: string }> {
  const { unitPath, backedUp } = await writeSystemdUnit(args);
  writeFormattedLines(
    stdout,
    [
      {
        label: "Staged systemd service",
        value: unitPath,
      },
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath };
}

async function activateSystemdService(params: { env: GatewayServiceEnv }) {
  const serviceName = resolveSystemdServiceName(params.env);
  const unitName = `${serviceName}.service`;
  // A system unit may appear after publication. Refuse before the user manager
  // can load a second supervisor for the same gateway name.
  await assertNoSystemGatewayOwnership(params.env);
  const reloadSystemd = async () => await execSystemctlUser(params.env, ["daemon-reload"]);
  const throwActivationFailure = (
    action: "daemon-reload" | "enable" | "restart",
    result: { stdout: string; stderr: string },
  ): never => {
    const detail = readSystemctlDetail(result);
    if (isSystemdUserScopeUnavailable(detail)) {
      throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
    }
    throw new Error(`systemctl ${action} failed: ${detail || "unknown error"}`.trim());
  };
  const reload = await reloadSystemd();
  if (reload.code !== 0) {
    throwActivationFailure("daemon-reload", reload);
  }

  const runAfterReloadRetry = async (action: "enable" | "restart") => {
    const result = await execSystemctlUser(params.env, [action, unitName]);
    if (
      result.code === 0 ||
      result.termination !== "exit" ||
      !isSystemdUnitMissingDetail(readSystemctlDetail(result))
    ) {
      return result;
    }
    const retryReload = await reloadSystemd();
    if (retryReload.code !== 0) {
      throwActivationFailure("daemon-reload", retryReload);
    }
    return await execSystemctlUser(params.env, [action, unitName]);
  };

  const enable = await runAfterReloadRetry("enable");
  if (enable.code !== 0) {
    throwActivationFailure("enable", enable);
  }

  const restart = await runAfterReloadRetry("restart");
  if (restart.code !== 0) {
    throwActivationFailure("restart", restart);
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
  writeFormattedLines(
    args.stdout,
    [
      {
        label: "Installed systemd service",
        value: unitPath,
      },
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSystemdAvailable(env);
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
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
  await removeNodeSystemdManagedEnvironmentKeys(env);
  if (removed) {
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } else {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}
