import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerMaintenanceCommands(program: Command) {
  program
    .command("doctor")
    .description("Health checks + quick fixes for the gateway and channels")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/doctor", "docs.openclaw.ai/cli/doctor")}\n`,
    )
    .option("--no-workspace-suggestions", "Disable workspace memory system suggestions", false)
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
    .option("--json", "With --lint or --post-upgrade: emit machine-readable JSON output", false)
    .option(
      "--severity-min <level>",
      "With --lint: drop findings below this severity (info|warning|error)",
    )
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
    .action(async (opts) => {
      if (opts.lint === true) {
        await runCommandWithRuntime(
          defaultRuntime,
          async () => {
            const { runDoctorLintCli } = await import("../../commands/doctor-lint.js");
            const exitCode = await runDoctorLintCli(defaultRuntime, {
              json: Boolean(opts.json),
              severityMin: typeof opts.severityMin === "string" ? opts.severityMin : undefined,
              skipIds: Array.isArray(opts.skip) ? opts.skip : [],
              onlyIds: Array.isArray(opts.only) ? opts.only : [],
              allowExec: Boolean(opts.allowExec),
            });
            defaultRuntime.exit(exitCode);
          },
          (err) => {
            defaultRuntime.error(String(err));
            defaultRuntime.exit(2);
          },
        );
        return;
      }
      if (hasLintOnlyDoctorOptions(opts)) {
        defaultRuntime.error(
          "doctor lint options require --lint. Use `openclaw doctor --lint ...`.",
        );
        defaultRuntime.exit(2);
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { doctorCommand } = await import("../../commands/doctor.js");
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
          json: Boolean(opts.json),
        });
        defaultRuntime.exit(0);
      });
    });

  program
    .command("dashboard")
    .description("Open the Control UI with your current token")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/dashboard", "docs.openclaw.ai/cli/dashboard")}\n`,
    )
    .option("--no-open", "Print URL but do not launch a browser")
    .option("--yes", "Start/install the gateway without prompting when needed", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { dashboardCommand } = await import("../../commands/dashboard.js");
        await dashboardCommand(defaultRuntime, {
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
  readonly json?: boolean;
  readonly postUpgrade?: boolean;
  readonly severityMin?: unknown;
  readonly skip?: unknown;
  readonly only?: unknown;
}): boolean {
  return (
    (opts.json === true && opts.postUpgrade !== true) ||
    typeof opts.severityMin === "string" ||
    (Array.isArray(opts.skip) && opts.skip.length > 0) ||
    (Array.isArray(opts.only) && opts.only.length > 0)
  );
}
