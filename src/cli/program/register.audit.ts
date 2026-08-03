// Audit command registration for privacy-preserving activity history.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { auditListCommand, type AuditListCommandOptions } from "../../commands/audit.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the bounded operator audit query command. */
export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .description("Inspect metadata-only run, tool, and message lifecycle records")
    .option("--agent <id>", "Filter by agent id")
    .option("--session <key>", "Filter by exact session key")
    .option("--run <id>", "Filter by run id")
    .option("--kind <kind>", "Filter by kind (agent_run, tool_action, or message)")
    .option(
      "--status <status>",
      "Filter by status (started, succeeded, failed, cancelled, timed_out, blocked, unknown)",
    )
    .option("--direction <direction>", "Filter message direction (inbound or outbound)")
    .option("--channel <channel>", "Filter message channel")
    .option("--after <timestamp>", "Include records at/after ISO time or Unix milliseconds")
    .option("--before <timestamp>", "Include records at/before ISO time or Unix milliseconds")
    .option("--cursor <sequence>", "Continue from a previous result cursor")
    .option("--limit <count>", "Maximum records (1-500)", "100")
    .option("--json", "Output a bounded JSON page", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/audit", "docs.openclaw.ai/cli/audit")}\n`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await auditListCommand(
          {
            agentId: opts.agent as string | undefined,
            sessionKey: opts.session as string | undefined,
            runId: opts.run as string | undefined,
            kind: opts.kind as AuditListCommandOptions["kind"],
            status: opts.status as AuditListCommandOptions["status"],
            direction: opts.direction as AuditListCommandOptions["direction"],
            channel: opts.channel as string | undefined,
            after: opts.after as string | undefined,
            before: opts.before as string | undefined,
            cursor: opts.cursor as string | undefined,
            limit: opts.limit as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}
