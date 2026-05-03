import { readConfigFileSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shouldMigrateStateFromPath } from "../argv.js";

const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);
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
let didRunDoctorConfigFlow = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function resetConfigGuardStateForTests() {
  didRunDoctorConfigFlow = false;
  configSnapshotPromise = null;
}

async function getConfigSnapshot() {
  // Tests often mutate config fixtures; caching can make those flaky.
  if (process.env.VITEST === "true") {
    return readConfigFileSnapshot();
  }
  configSnapshotPromise ??= readConfigFileSnapshot();
  return configSnapshotPromise;
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
  suppressDoctorStdout?: boolean;
  allowInvalid?: boolean;
}): Promise<void> {
  const commandPath = params.commandPath ?? [];
  let preflightSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | null = null;
  if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
    didRunDoctorConfigFlow = true;
    const runDoctorConfigPreflight = async () =>
      (await import("../../commands/doctor-config-preflight.js")).runDoctorConfigPreflight({
        // Keep ordinary CLI startup on the lightweight validation path.
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
    if (!params.suppressDoctorStdout) {
      preflightSnapshot = (await runDoctorConfigPreflight()).snapshot;
    } else {
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalSuppressNotes = process.env.OPENCLAW_SUPPRESS_NOTES;
      process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
      process.env.OPENCLAW_SUPPRESS_NOTES = "1";
      try {
        preflightSnapshot = (await runDoctorConfigPreflight()).snapshot;
      } finally {
        process.stdout.write = originalStdoutWrite;
        if (originalSuppressNotes === undefined) {
          delete process.env.OPENCLAW_SUPPRESS_NOTES;
        } else {
          process.env.OPENCLAW_SUPPRESS_NOTES = originalSuppressNotes;
        }
      }
    }
  }

  const snapshot = preflightSnapshot ?? (await getConfigSnapshot());
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const isBareGatewayForegroundRun =
    commandName === "gateway" && (subcommandName === undefined || subcommandName.trim() === "");
  const allowInvalid = commandName
    ? params.allowInvalid === true ||
      ALLOWED_INVALID_COMMANDS.has(commandName) ||
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

  const [{ colorize, isRich, theme }, { shortenHomePath }, { formatCliCommand }] =
    await Promise.all([
      import("../../terminal/theme.js"),
      import("../../utils.js"),
      import("../command-format.js"),
    ]);
  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("Config invalid"));
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
  params.runtime.error(
    `${muted("Run:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`,
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}

export const __test__ = {
  resetConfigGuardStateForTests,
};
