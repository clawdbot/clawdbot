// CLI config readiness guard, legacy-state migration routing, and invalid-config allowances.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withSuppressedNotes } from "../../../packages/terminal-core/src/note.js";
import { readConfigFileSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  isNamedProfile,
  resolveLegacyStateDirs,
  resolveNewStateDir,
  resolveOAuthDir,
  resolveStateDir,
} from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import { shouldMigrateStateFromPath } from "../argv.js";

const ALLOWED_INVALID_COMMANDS = new Set(["audit", "doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "run",
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
const ALLOWED_INVALID_TASK_SUBCOMMANDS = new Set(["list", "audit"]);
let didRunDoctorConfigFlow = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function resetConfigGuardStateForTests() {
  didRunDoctorConfigFlow = false;
  configSnapshotPromise = null;
}

function fileOrDirExists(pathname: string): boolean {
  try {
    return fs.existsSync(pathname);
  } catch {
    return false;
  }
}

function dirHasFile(dir: string, predicate: (name: string) => boolean): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && predicate(entry.name));
  } catch {
    return false;
  }
}

function isLegacyWhatsAppAuthFile(name: string): boolean {
  if (name === "creds.json" || name === "creds.json.bak") {
    return true;
  }
  return name.endsWith(".json") && /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}

function isLegacyTelegramStateFile(name: string): boolean {
  return (
    (name.startsWith("bot-info-") && name.endsWith(".json")) ||
    (name.startsWith("update-offset-") && name.endsWith(".json")) ||
    name === "sticker-cache.json" ||
    (name.startsWith("thread-bindings-") && name.endsWith(".json"))
  );
}

function hasLegacyIMessageStateFiles(stateDir: string): boolean {
  return (
    fileOrDirExists(path.join(stateDir, "imessage", "reply-cache.jsonl")) ||
    fileOrDirExists(path.join(stateDir, "imessage", "sent-echoes.jsonl")) ||
    dirHasFile(path.join(stateDir, "imessage", "catchup"), (name) => name.endsWith(".json"))
  );
}

function hasBundledChannelLegacyStateMigrationInputs(stateDir: string, oauthDir: string): boolean {
  if (
    fileOrDirExists(path.join(stateDir, "discord", "model-picker-preferences.json")) ||
    fileOrDirExists(path.join(stateDir, "discord", "thread-bindings.json"))
  ) {
    return true;
  }
  if (hasLegacyIMessageStateFiles(stateDir)) {
    return true;
  }
  if (
    fileOrDirExists(path.join(oauthDir, "telegram-allowFrom.json")) ||
    dirHasFile(path.join(stateDir, "telegram"), isLegacyTelegramStateFile)
  ) {
    return true;
  }
  return dirHasFile(oauthDir, isLegacyWhatsAppAuthFile);
}

function hasCrossStateDirApprovalMigrationInputs(stateDir: string): boolean {
  if (!process.env.OPENCLAW_STATE_DIR?.trim() || isNamedProfile()) {
    return false;
  }
  const homeDir = resolveRequiredHomeDir(process.env, os.homedir);
  const defaultStateDir = resolveNewStateDir(() => homeDir);
  if (path.resolve(defaultStateDir) === path.resolve(stateDir)) {
    return false;
  }
  const execApprovalsSource = path.join(defaultStateDir, "exec-approvals.json");
  const execApprovalsTarget = path.join(stateDir, "exec-approvals.json");
  return (
    (fileOrDirExists(execApprovalsSource) && !fileOrDirExists(execApprovalsTarget)) ||
    fileOrDirExists(path.join(defaultStateDir, "plugin-binding-approvals.json"))
  );
}

function hasPendingSqliteSidecarArchive(sourcePath: string): boolean {
  return (
    fileOrDirExists(`${sourcePath}.migrated`) &&
    ["-shm", "-wal", "-journal"].some((suffix) => fileOrDirExists(`${sourcePath}${suffix}`))
  );
}

function hasLegacyStateMigrationInputs(): boolean {
  // Only run migration prompts when old state actually exists in known legacy locations.
  const stateDir = resolveStateDir(process.env, os.homedir);
  const oauthDir = resolveOAuthDir(process.env, stateDir);
  if (
    !process.env.OPENCLAW_STATE_DIR?.trim() &&
    resolveLegacyStateDirs(() => resolveRequiredHomeDir(process.env, os.homedir)).some(
      fileOrDirExists,
    )
  ) {
    return true;
  }
  const sqliteSidecarPaths = [
    path.join(stateDir, "flows", "registry.sqlite"),
    path.join(stateDir, "plugin-state", "state.sqlite"),
    path.join(stateDir, "tasks", "runs.sqlite"),
  ];
  return (
    [
      path.join(stateDir, "agent"),
      path.join(stateDir, "agents"),
      path.join(stateDir, "plugins", "installs.json"),
      path.join(stateDir, "sessions"),
      path.join(stateDir, "state", "openclaw.sqlite"),
    ].some(fileOrDirExists) ||
    sqliteSidecarPaths.some(
      (sourcePath) => fileOrDirExists(sourcePath) || hasPendingSqliteSidecarArchive(sourcePath),
    ) ||
    hasBundledChannelLegacyStateMigrationInputs(stateDir, oauthDir) ||
    hasCrossStateDirApprovalMigrationInputs(stateDir)
  );
}

function shouldRunStateMigrationOnlyWithLegacyInputs(commandPath: string[]): boolean {
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  // Metadata-only plugin listing still migrates known legacy inputs, but an empty
  // state must not cold-load doctor and bundled channel runtime graphs.
  return (
    commandName === "agent" ||
    commandName === "status" ||
    (commandName === "plugins" && subcommandName === "list") ||
    (commandName === "tasks" &&
      (subcommandName === undefined || ALLOWED_INVALID_TASK_SUBCOMMANDS.has(subcommandName)))
  );
}

function snapshotHasConfiguredSessionStore(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): boolean {
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const store = cfg?.session?.store;
  return typeof store === "string" && store.trim().length > 0;
}

function shouldRequireStartupMigrationCheckpoint(commandPath: string[]): boolean {
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  return (
    commandName === "gateway" &&
    (subcommandName === undefined || subcommandName === "run" || subcommandName.trim() === "")
  );
}

async function getConfigSnapshot(options?: { observe: false }) {
  if (options?.observe === false) {
    return readConfigFileSnapshot(options);
  }
  // Tests often mutate config fixtures; caching can make those flaky.
  if (process.env.VITEST === "true") {
    return readConfigFileSnapshot();
  }
  if (!configSnapshotPromise) {
    const pendingSnapshot = readConfigFileSnapshot();
    configSnapshotPromise = pendingSnapshot;
    pendingSnapshot.catch(() => {
      if (configSnapshotPromise === pendingSnapshot) {
        configSnapshotPromise = null;
      }
    });
  }
  return configSnapshotPromise;
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
  suppressDoctorStdout?: boolean;
  allowInvalid?: boolean;
  beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
}): Promise<void> {
  const commandPath = params.commandPath ?? [];
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  let preflightSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | null = null;
  const shouldConsiderStateMigration = shouldMigrateStateFromPath(commandPath);
  const requiresLegacyStateInput = shouldRunStateMigrationOnlyWithLegacyInputs(commandPath);
  const runStateMigrationPreflight = async () => {
    didRunDoctorConfigFlow = true;
    const runDoctorConfigPreflight = async () =>
      (await import("../../commands/doctor-config-preflight.js")).runDoctorConfigPreflight({
        migrateState: true,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        ...(commandName === "status" ? { observe: false } : {}),
        crossStateDirImports: false,
        ...(shouldRequireStartupMigrationCheckpoint(commandPath)
          ? { requireStartupMigrationCheckpoint: true }
          : {}),
        ...(params.beforeStateMigrations
          ? { beforeStateMigrations: params.beforeStateMigrations }
          : {}),
      });
    try {
      return !params.suppressDoctorStdout
        ? (await runDoctorConfigPreflight()).snapshot
        : (await withSuppressedNotes(runDoctorConfigPreflight)).snapshot;
    } catch (error) {
      if (error instanceof ExitError) {
        // The migration owner has unwound its lease and heartbeat before this handoff.
        params.runtime.exit(error.code);
      }
      throw error;
    }
  };
  if (
    !didRunDoctorConfigFlow &&
    shouldConsiderStateMigration &&
    (!requiresLegacyStateInput || hasLegacyStateMigrationInputs())
  ) {
    preflightSnapshot = await runStateMigrationPreflight();
  }

  // Status performs a second non-observing read for its materialized/source pair;
  // keep the startup guard from recording config health before the command begins.
  const configSnapshotOptions =
    commandName === "status" ? ({ observe: false } as const) : undefined;
  let snapshot = preflightSnapshot ?? (await getConfigSnapshot(configSnapshotOptions));
  if (
    !preflightSnapshot &&
    !didRunDoctorConfigFlow &&
    shouldConsiderStateMigration &&
    requiresLegacyStateInput &&
    snapshot.valid &&
    snapshotHasConfiguredSessionStore(snapshot)
  ) {
    preflightSnapshot = await runStateMigrationPreflight();
    snapshot = preflightSnapshot;
  }
  const isBareGatewayForegroundRun =
    commandName === "gateway" && (subcommandName === undefined || subcommandName.trim() === "");
  const isReadOnlyTaskStateCommand =
    commandName === "tasks" &&
    (subcommandName === undefined || ALLOWED_INVALID_TASK_SUBCOMMANDS.has(subcommandName));
  const allowInvalid = commandName
    ? params.allowInvalid === true ||
      ALLOWED_INVALID_COMMANDS.has(commandName) ||
      isReadOnlyTaskStateCommand ||
      isBareGatewayForegroundRun ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const { formatConfigIssueLines } = await import("../../config/issue-format.js");
  const issues =
    snapshot.exists && !snapshot.valid
      ? formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })
      : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0 ? formatConfigIssueLines(snapshot.legacyIssues, "-") : [];

  const invalid = snapshot.exists && !snapshot.valid;
  if (!invalid) {
    setRuntimeConfigSnapshot(snapshot.runtimeConfig ?? snapshot.config, snapshot.sourceConfig);
  }
  if (!invalid) {
    return;
  }

  const [
    { colorize, isRich, theme },
    { shortenHomePath },
    { formatCliCommand },
    { isPluginPackagingRuntimeOutputInvalidConfigSnapshot },
    { formatPluginPackagingRuntimeOutputRecoveryHint },
  ] = await Promise.all([
    import("../../../packages/terminal-core/src/theme.js"),
    import("../../utils.js"),
    import("../command-format.js"),
    import("../../config/recovery-policy.js"),
    import("../config-recovery-hints.js"),
  ]);
  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("OpenClaw config is invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  const fixHint = isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
    ? formatPluginPackagingRuntimeOutputRecoveryHint()
    : commandText(formatCliCommand("openclaw doctor --fix"));
  params.runtime.error(`${muted("Fix:")} ${fixHint}`);
  params.runtime.error(
    `${muted("Inspect:")} ${commandText(formatCliCommand("openclaw config validate"))}`,
  );
  params.runtime.error(
    muted(
      "Audit, status, health, logs, tasks list/audit, and doctor commands still run with invalid config.",
    ),
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}

export const testApi = {
  resetConfigGuardStateForTests,
};
export { testApi as __test__ };
