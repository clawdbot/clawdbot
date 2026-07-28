// Doctor migration for config and state left by the retired Phone Control lease model.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { archiveLegacyStateSource } from "../plugins/doctor-state-migration-fs.js";

const PHONE_CONTROL_PLUGIN_ID = "phone-control";
const ARM_STATE_NAMESPACE = "armed";
const RETIRED_ARM_GROUPS = new Set(["camera", "screen", "computer", "mobile-ui", "writes", "all"]);

// This is the exact pre-retirement setup seed. Keep it independent of the
// current dangerous-command set so future policy changes cannot widen cleanup.
const RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "computer.act",
  "mobile.ui.observe",
  "mobile.ui.act",
  "contacts.add",
  "calendar.add",
  "reminders.add",
  "sms.send",
  "sms.search",
  "health.summary",
] as const;

type RetiredArmState = {
  version?: unknown;
  addedToAllow?: unknown;
  removedFromDeny?: unknown;
};

type RetiredPhoneControlCleanupPlan = {
  config: OpenClawConfig;
  configChanges: string[];
  cleanupPending: boolean;
  cleanupSafe: boolean;
  warnings: string[];
};

function resolveLegacyArmStatePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "plugins", PHONE_CONTROL_PLUGIN_ID, "armed.json");
}

function resolveStateDatabasePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "state", "openclaw.sqlite");
}

type StatePathInspection =
  | { status: "file" }
  | { status: "missing" }
  | { status: "unsafe"; warning: string };

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function inspectStatePath(filePath: string, label: string): Promise<StatePathInspection> {
  try {
    return (await fs.stat(filePath)).isFile()
      ? { status: "file" }
      : { status: "unsafe", warning: `${label} at ${filePath} is not a regular file.` };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { status: "missing" };
    }
    return {
      status: "unsafe",
      warning: `Could not inspect ${label} at ${filePath}: ${String(error)}`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "")
  );
}

function isTimestamp(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRetiredArmState(value: unknown): value is RetiredArmState {
  if (!isRecord(value) || !isTimestamp(value.armedAtMs)) {
    return false;
  }
  if (value.expiresAtMs !== null && !isTimestamp(value.expiresAtMs)) {
    return false;
  }
  if (value.version === 1) {
    return isStringArray(value.removedFromDeny);
  }
  if (value.version !== 2 && value.version !== 3) {
    return false;
  }
  if (
    typeof value.group !== "string" ||
    !RETIRED_ARM_GROUPS.has(value.group) ||
    !isStringArray(value.armedCommands) ||
    !isStringArray(value.addedToAllow) ||
    !isStringArray(value.removedFromDeny)
  ) {
    return false;
  }
  if (value.version === 2) {
    return true;
  }
  return (
    typeof value.generation === "string" &&
    value.generation.trim() !== "" &&
    (value.phase === "preparing" || value.phase === "active") &&
    isStringArray(value.persistentAllows)
  );
}

function readStringArrayField(value: unknown, field: keyof RetiredArmState): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const entries = (value as RetiredArmState)[field];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function openRetiredArmStateStore(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStore<unknown>(PHONE_CONTROL_PLUGIN_ID, {
    namespace: ARM_STATE_NAMESPACE,
    maxEntries: 1,
    overflowPolicy: "reject-new",
    env,
  });
}

async function readRetiredArmStates(env: NodeJS.ProcessEnv): Promise<{
  states: unknown[];
  cleanupPending: boolean;
  cleanupSafe: boolean;
  warnings: string[];
}> {
  const legacyPath = resolveLegacyArmStatePath(env);
  const databasePath = resolveStateDatabasePath(env);
  const [legacyInspection, databaseInspection] = await Promise.all([
    inspectStatePath(legacyPath, "retired Phone Control lease state"),
    inspectStatePath(databasePath, "OpenClaw state database"),
  ]);
  const warnings: string[] = [];
  const inspectionUnsafe =
    legacyInspection.status === "unsafe" || databaseInspection.status === "unsafe";
  if (legacyInspection.status === "unsafe") {
    warnings.push(legacyInspection.warning);
  }
  if (databaseInspection.status === "unsafe") {
    warnings.push(databaseInspection.warning);
  }

  let legacyState: unknown;
  let legacyStateValid = false;
  if (legacyInspection.status === "file") {
    try {
      legacyState = JSON.parse(await fs.readFile(legacyPath, "utf8")) as unknown;
      legacyStateValid = isRetiredArmState(legacyState);
      if (!legacyStateValid) {
        warnings.push(`Retired Phone Control lease state at ${legacyPath} is malformed.`);
      }
    } catch (error) {
      warnings.push(
        `Could not read retired Phone Control lease state at ${legacyPath}: ${String(error)}`,
      );
    }
  }
  let sqliteReadFailed = false;
  let sqliteEntries: Array<{ value: unknown }> = [];
  if (databaseInspection.status === "file") {
    try {
      sqliteEntries = await openRetiredArmStateStore(env).entries();
      if (sqliteEntries.length > 1) {
        sqliteReadFailed = true;
        warnings.push("Retired Phone Control lease journal contains multiple records.");
      } else if (sqliteEntries.length === 1 && !isRetiredArmState(sqliteEntries[0]?.value)) {
        sqliteReadFailed = true;
        warnings.push("Retired Phone Control lease journal contains a malformed record.");
      }
    } catch (error) {
      sqliteReadFailed = true;
      warnings.push(`Could not read retired Phone Control lease journal: ${String(error)}`);
    }
  }
  const hasCanonicalState = sqliteEntries.length === 1 && !sqliteReadFailed;
  const cleanupSafe =
    !inspectionUnsafe &&
    !sqliteReadFailed &&
    (hasCanonicalState || legacyInspection.status !== "file" || legacyStateValid);
  // SQLite became the canonical journal before retirement. A legacy source may
  // coexist after an interrupted older migration, but it must not contribute
  // cleanup deltas when the authoritative SQLite record exists.
  const states = cleanupSafe
    ? hasCanonicalState
      ? sqliteEntries.map((entry) => entry.value)
      : legacyStateValid
        ? [legacyState]
        : []
    : [];
  return {
    states,
    cleanupPending:
      inspectionUnsafe ||
      legacyInspection.status !== "missing" ||
      sqliteEntries.length > 0 ||
      sqliteReadFailed,
    cleanupSafe,
    warnings,
  };
}

function isExactSeededDenyList(values: readonly string[]): boolean {
  const normalized = [...values].toSorted();
  const expected = [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS].toSorted();
  return (
    normalized.length === expected.length &&
    normalized.every((value, index) => value === expected[index])
  );
}

function withCommandLists(
  cfg: OpenClawConfig,
  params: { allow?: string[]; deny?: string[] },
): OpenClawConfig {
  const commands = { ...cfg.gateway?.nodes?.commands };
  if (params.allow === undefined || params.allow.length === 0) {
    delete commands.allow;
  } else {
    commands.allow = params.allow;
  }
  if (params.deny === undefined || params.deny.length === 0) {
    delete commands.deny;
  } else {
    commands.deny = params.deny;
  }
  const nodes = { ...cfg.gateway?.nodes };
  delete nodes.commands;
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      nodes: {
        ...nodes,
        ...(Object.keys(commands).length > 0 ? { commands } : {}),
      },
    },
  };
}

/** Plans canonical config cleanup while retaining the journal until the config write succeeds. */
export async function prepareRetiredPhoneControlCleanup(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<RetiredPhoneControlCleanupPlan> {
  const env = params.env ?? process.env;
  const residue = await readRetiredArmStates(env);
  if (!residue.cleanupSafe) {
    return {
      config: params.cfg,
      configChanges: [],
      cleanupPending: residue.cleanupPending,
      cleanupSafe: false,
      warnings: residue.warnings,
    };
  }
  const leaseAddedAllows = new Set(
    residue.states.flatMap((state) => readStringArrayField(state, "addedToAllow")),
  );
  const leaseRemovedDenies = residue.states.flatMap((state) =>
    readStringArrayField(state, "removedFromDeny"),
  );
  const currentAllow = params.cfg.gateway?.nodes?.commands?.allow;
  const currentDeny = params.cfg.gateway?.nodes?.commands?.deny;
  const reconstructedDeny = [...(currentDeny ?? [])];
  const reconstructedDenySet = new Set(reconstructedDeny);
  for (const command of leaseRemovedDenies) {
    if (!reconstructedDenySet.has(command)) {
      reconstructedDeny.push(command);
      reconstructedDenySet.add(command);
    }
  }
  const removeSeededDeny = currentDeny !== undefined && isExactSeededDenyList(reconstructedDeny);
  // The lease journal snapshots persistentAllows through deny-wins policy before
  // activation, so commands in removedFromDeny are lease-only even if also allowed.
  const leaseShadowedAllows = removeSeededDeny ? new Set(leaseRemovedDenies) : undefined;
  const nextAllow = currentAllow?.filter(
    (command) => !leaseAddedAllows.has(command.trim()) && !leaseShadowedAllows?.has(command.trim()),
  );
  const nextDeny = removeSeededDeny
    ? reconstructedDeny.filter((command) => nextAllow?.includes(command))
    : reconstructedDeny;
  const allowChanged = Boolean(currentAllow && nextAllow?.length !== currentAllow.length);
  const denyChanged = reconstructedDeny.length !== (currentDeny?.length ?? 0);
  if (!allowChanged && !denyChanged && !removeSeededDeny) {
    return {
      config: params.cfg,
      configChanges: [],
      cleanupPending: residue.cleanupPending,
      cleanupSafe: residue.cleanupSafe,
      warnings: residue.warnings,
    };
  }

  const configChanges: string[] = [];
  if (allowChanged) {
    configChanges.push("Removed stale Phone Control lease-only command allow entries.");
  }
  if (denyChanged && !removeSeededDeny) {
    configChanges.push("Restored command deny entries removed by Phone Control leases.");
  }
  if (removeSeededDeny) {
    configChanges.push("Removed the retired Phone Control setup deny seed.");
  }
  return {
    config: withCommandLists(params.cfg, {
      allow: nextAllow,
      deny: nextDeny,
    }),
    configChanges,
    cleanupPending: residue.cleanupPending,
    cleanupSafe: residue.cleanupSafe,
    warnings: residue.warnings,
  };
}

/** Drops SQLite journal rows and archives the legacy file after config persistence. */
export async function finalizeRetiredPhoneControlCleanup(params: {
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  const legacyPath = resolveLegacyArmStatePath(env);
  const legacyInspection = await inspectStatePath(legacyPath, "retired Phone Control lease state");
  if (legacyInspection.status === "unsafe") {
    warnings.push(legacyInspection.warning);
    return { changes, warnings };
  }
  if (legacyInspection.status === "file") {
    await archiveLegacyStateSource({
      filePath: legacyPath,
      label: "retired Phone Control lease state",
      changes,
      warnings,
    });
    // SQLite is authoritative while both sources exist. Keep that record until
    // the stale fallback source is gone, or a later retry could replay it.
    const postArchiveInspection = await inspectStatePath(
      legacyPath,
      "retired Phone Control lease state",
    );
    if (postArchiveInspection.status === "unsafe") {
      warnings.push(postArchiveInspection.warning);
    }
    if (postArchiveInspection.status !== "missing") {
      return { changes, warnings };
    }
  }

  const databaseInspection = await inspectStatePath(
    resolveStateDatabasePath(env),
    "OpenClaw state database",
  );
  if (databaseInspection.status === "unsafe") {
    warnings.push(databaseInspection.warning);
    return { changes, warnings };
  }
  if (databaseInspection.status === "file") {
    try {
      const store = openRetiredArmStateStore(env);
      if ((await store.entries()).length > 0) {
        await store.clear();
        changes.push("Dropped the retired Phone Control lease journal.");
      }
    } catch (error) {
      warnings.push(`Failed to drop the retired Phone Control lease journal: ${String(error)}`);
    }
  }
  return { changes, warnings };
}
