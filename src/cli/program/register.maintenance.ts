// Maintenance command registration: doctor, dashboard, reset, and uninstall.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { formatErrorMessage as formatError, runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions } from "../command-options.js";
import { isDoctorMachineOutput } from "../doctor-output-mode.js";
import { formatCliJsonFailure } from "../failure-output.js";
import { setCommandJsonMode } from "./json-mode.js";

const STATE_SQLITE_CONFLICTING_OPTION_NAMES = [
  "workspaceSuggestions",
  "yes",
  "repair",
  "fix",
  "force",
  "nonInteractive",
  "generateGatewayToken",
  "allowExec",
  "deep",
  "lint",
  "postUpgrade",
  "sessionSqlite",
  "sessionSqliteStore",
  "sessionSqliteAgent",
  "sessionSqliteAllAgents",
  "githubIssue",
  "severityMin",
  "all",
  "skip",
  "only",
] as const;

function exitDoctorError(message: string, json: boolean): void {
  if (json) {
    defaultRuntime.writeJson(formatCliJsonFailure(message));
  } else {
    defaultRuntime.error(message);
  }
  defaultRuntime.exit(2);
}

/** Register maintenance commands that inspect or mutate local OpenClaw state. */
export function registerMaintenanceCommands(program: Command) {
  const doctor = program
    .command("doctor")
    .description("Health checks + quick fixes for the gateway and channels")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/doctor", "docs.openclaw.ai/cli/doctor")}\n`,
    )
    .option("--no-workspace-suggestions", "Disable workspace memory system suggestions", true)
    .option("--yes", "Accept defaults without prompting", false)
    .option("--repair", "Apply recommended repairs without prompting", false)
    .option("--fix", "Apply recommended repairs (alias for --repair)", false)
    .option("--force", "Apply aggressive repairs (overwrites custom service config)", false)
    .option("--non-interactive", "Run without prompts (safe migrations only)", false)
    .option("--generate-gateway-token", "Generate and configure a gateway token", false)
    .option(
      "--allow-exec",
      "Allow doctor to execute exec SecretRefs while verifying configured secrets",
      false,
    )
    .option("--deep", "Scan system services for extra gateway installs", false)
    .option("--lint", "Run read-only health checks and report findings", false)
    .option(
      "--post-upgrade",
      "Emit plugin-compat findings only (machine-readable with --json)",
      false,
    )
    .option(
      "--session-sqlite <mode>",
      "Run session SQLite migration mode (dry-run|import|validate|inspect|compact|restore|recover)",
    )
    .option("--state-sqlite <mode>", "Run shared state SQLite maintenance mode (compact)")
    .option("--session-sqlite-store <path>", "With --session-sqlite: inspect one session store")
    .option("--session-sqlite-agent <id>", "With --session-sqlite: inspect one agent")
    .option(
      "--session-sqlite-all-agents",
      "With --session-sqlite: inspect configured and discovered agent stores",
      false,
    )
    .option(
      "--github-issue",
      "With --session-sqlite recover: prepare and optionally create an openclaw/openclaw issue",
      false,
    )
    .option("--json", "Emit JSON; bare --json runs advisory read-only health checks", false)
    .option(
      "--severity-min <level>",
      "With --lint: drop findings below this severity (info|warning|error)",
    )
    .option("--all", "With --lint: run all registered checks, including opt-in checks", false)
    .option(
      "--skip <id>",
      "With --lint: skip a specific check id (repeatable)",
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .option(
      "--only <id>",
      "With --lint: run only the specified check id (repeatable)",
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .action(async (opts, command) => {
      if (
        typeof opts.stateSqlite === "string" &&
        hasExplicitOptions(command, STATE_SQLITE_CONFLICTING_OPTION_NAMES)
      ) {
        return exitDoctorError(
          "doctor shared-state SQLite maintenance can only be combined with --json.",
          opts.json === true,
        );
      }
      const jsonImpliesLint =
        opts.json === true &&
        opts.lint !== true &&
        opts.postUpgrade !== true &&
        typeof opts.stateSqlite !== "string" &&
        typeof opts.sessionSqlite !== "string" &&
        !hasSessionSqliteOnlyDoctorOptions(opts);
      if (jsonImpliesLint && (opts.repair === true || opts.fix === true || opts.force === true)) {
        return exitDoctorError(
          "doctor --json runs read-only lint checks and cannot be combined with --repair, --fix, or --force.",
          true,
        );
      }
      if (opts.lint === true || jsonImpliesLint) {
        await runCommandWithRuntime(
          defaultRuntime,
          async () => {
            const { runDoctorLintCli } = await import("../../commands/doctor-lint.js");
            const exitCode = await runDoctorLintCli(defaultRuntime, {
              json: Boolean(opts.json),
              severityMin: typeof opts.severityMin === "string" ? opts.severityMin : undefined,
              includeAllChecks: Boolean(opts.all),
              skipIds: Array.isArray(opts.skip) ? opts.skip : [],
              onlyIds: Array.isArray(opts.only) ? opts.only : [],
              allowExec: Boolean(opts.allowExec),
              deep: Boolean(opts.deep),
            });
            defaultRuntime.exit(jsonImpliesLint ? 0 : exitCode);
          },
          (err) => exitDoctorError(formatError(err), opts.json === true || !process.stdout.isTTY),
        );
        return;
      }
      if (hasSessionSqliteOnlyDoctorOptions(opts)) {
        return exitDoctorError(
          "doctor session SQLite options require --session-sqlite. Use `openclaw doctor --session-sqlite dry-run ...`.",
          opts.json === true,
        );
      }
      if (hasLintOnlyDoctorOptions(opts)) {
        return exitDoctorError(
          "doctor lint options require --lint. Use `openclaw doctor --lint ...`.",
          opts.json === true,
        );
      }
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const { doctorCommand } = await import("../../commands/doctor.js");
          const stateSqlite = parseDoctorStateSqliteMode(opts.stateSqlite, opts.json === true);
          const sessionSqlite = parseDoctorSessionSqliteMode(
            opts.sessionSqlite,
            opts.json === true,
          );
          await doctorCommand(defaultRuntime, {
            workspaceSuggestions: opts.workspaceSuggestions,
            yes: Boolean(opts.yes),
            repair: Boolean(opts.repair) || Boolean(opts.fix),
            force: Boolean(opts.force),
            nonInteractive: Boolean(opts.nonInteractive),
            generateGatewayToken: Boolean(opts.generateGatewayToken),
            allowExec: Boolean(opts.allowExec),
            deep: Boolean(opts.deep),
            postUpgrade: Boolean(opts.postUpgrade),
            ...(stateSqlite ? { stateSqlite } : {}),
            ...(sessionSqlite ? { sessionSqlite } : {}),
            ...(typeof opts.sessionSqliteStore === "string"
              ? { sessionSqliteStore: opts.sessionSqliteStore }
              : {}),
            ...(typeof opts.sessionSqliteAgent === "string"
              ? { sessionSqliteAgent: opts.sessionSqliteAgent }
              : {}),
            sessionSqliteAllAgents: Boolean(opts.sessionSqliteAllAgents),
            sessionSqliteGithubIssue: Boolean(opts.githubIssue),
            json: Boolean(opts.json),
          });
          defaultRuntime.exit(0);
        },
        opts.json ? (err: unknown) => exitDoctorError(formatError(err), true) : undefined,
      );
    });
  setCommandJsonMode(doctor, "output", isDoctorMachineOutput);

  program
    .command("dashboard")
    .description("Open the Control UI with your current token")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/dashboard", "docs.openclaw.ai/cli/dashboard")}\n`,
    )
    .option("--no-open", "Print URL but do not launch a browser")
    .option("--json", "Output dashboard connection details as JSON", false)
    .option("--yes", "Start/install the gateway without prompting when needed", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { dashboardCommand } = await import("../../commands/dashboard.js");
        await dashboardCommand(defaultRuntime, {
          json: Boolean(opts.json),
          noOpen: opts.open === false,
          yes: Boolean(opts.yes),
        });
      });
    });

  program
    .command("reset")
    .description("Reset local config/state (keeps the CLI installed)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/reset", "docs.openclaw.ai/cli/reset")}\n`,
    )
    .option("--scope <scope>", "config|config+creds+sessions|full (default: interactive prompt)")
    .option("--yes", "Skip confirmation prompts", false)
    .option("--non-interactive", "Disable prompts (requires --scope + --yes)", false)
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { resetCommand } = await import("../../commands/reset.js");
        await resetCommand(defaultRuntime, {
          scope: opts.scope,
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });

  program
    .command("uninstall")
    .description("Uninstall the gateway service + local data (CLI remains)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/uninstall", "docs.openclaw.ai/cli/uninstall")}\n`,
    )
    .option("--service", "Remove the gateway service", false)
    .option("--state", "Remove state + config", false)
    .option("--workspace", "Remove workspace dirs", false)
    .option("--app", "Remove the macOS app", false)
    .option("--all", "Remove service + state + workspace + app", false)
    .option("--yes", "Skip confirmation prompts", false)
    .option("--non-interactive", "Disable prompts (requires --yes)", false)
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { uninstallCommand } = await import("../../commands/uninstall.js");
        await uninstallCommand(defaultRuntime, {
          service: Boolean(opts.service),
          state: Boolean(opts.state),
          workspace: Boolean(opts.workspace),
          app: Boolean(opts.app),
          all: Boolean(opts.all),
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });
}

function hasLintOnlyDoctorOptions(opts: {
  readonly severityMin?: unknown;
  readonly all?: boolean;
  readonly skip?: unknown;
  readonly only?: unknown;
}): boolean {
  return (
    typeof opts.severityMin === "string" ||
    opts.all === true ||
    (Array.isArray(opts.skip) && opts.skip.length > 0) ||
    (Array.isArray(opts.only) && opts.only.length > 0)
  );
}

function hasSessionSqliteOnlyDoctorOptions(opts: {
  readonly sessionSqlite?: unknown;
  readonly sessionSqliteAgent?: unknown;
  readonly sessionSqliteAllAgents?: unknown;
  readonly githubIssue?: unknown;
  readonly sessionSqliteStore?: unknown;
}): boolean {
  return (
    typeof opts.sessionSqlite !== "string" &&
    (typeof opts.sessionSqliteAgent === "string" ||
      opts.githubIssue === true ||
      opts.sessionSqliteAllAgents === true ||
      typeof opts.sessionSqliteStore === "string")
  );
}

function parseDoctorStateSqliteMode(value: unknown, json: boolean): "compact" | undefined {
  if (value === undefined || value === "compact") {
    return value;
  }
  exitDoctorError("Invalid --state-sqlite mode. Use compact.", json);
  throw new Error("unreachable");
}

function parseDoctorSessionSqliteMode(
  value: unknown,
  json: boolean,
): "dry-run" | "import" | "validate" | "inspect" | "compact" | "restore" | "recover" | undefined {
  if (
    value === undefined ||
    value === "dry-run" ||
    value === "import" ||
    value === "validate" ||
    value === "inspect" ||
    value === "compact" ||
    value === "restore" ||
    value === "recover"
  ) {
    return value;
  }
  exitDoctorError(
    "Invalid --session-sqlite mode. Use dry-run, import, validate, inspect, compact, restore, or recover.",
    json,
  );
  throw new Error("unreachable");
}
