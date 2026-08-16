// Audit command registration for privacy-preserving activity history.
import type { Command } from "commander";
import {
  AUDIT_ACTIVITY_DIRECTIONS,
  AUDIT_ACTIVITY_KINDS,
  AUDIT_ACTIVITY_STATUSES,
} from "../../../packages/gateway-protocol/src/schema/audit-activity.js";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { auditListCommand, type AuditListCommandOptions } from "../../commands/audit.js";
import { defaultRuntime } from "../../runtime.js";
import { formatHumanList } from "../../shared/human-list.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the bounded operator audit query command. */
export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .description("Inspect activity records and exact-run identity context")
    .option("--agent <id>", "Filter by agent id")
    .option("--session <key>", "Filter by exact session key")
    .option("--run <id>", "Filter by run id")
    .option("--execution <id>", "Inspect one exact execution id")
    .option("--kind <kind>", `Filter by kind (${formatHumanList(AUDIT_ACTIVITY_KINDS)})`)
    .option("--status <status>", `Filter by status (${formatHumanList(AUDIT_ACTIVITY_STATUSES)})`)
    .option(
      "--direction <direction>",
      `Filter message direction (${formatHumanList(AUDIT_ACTIVITY_DIRECTIONS)})`,
    )
    .option("--channel <channel>", "Filter message channel")
    .option("--after <timestamp>", "Include records at/after ISO time or Unix milliseconds")
    .option("--before <timestamp>", "Include records at/before ISO time or Unix milliseconds")
    .option("--cursor <sequence>", "Continue from a previous result cursor")
    .option("--limit <count>", "Maximum records (1-500; decisions 1-100)")
    .option("--explain", "Inspect execution identity and run-admission reasoning", false)
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
            executionId: opts.execution as string | undefined,
            kind: opts.kind as AuditListCommandOptions["kind"],
            status: opts.status as AuditListCommandOptions["status"],
            direction: opts.direction as AuditListCommandOptions["direction"],
            channel: opts.channel as string | undefined,
            after: opts.after as string | undefined,
            before: opts.before as string | undefined,
            cursor: opts.cursor as string | undefined,
            limit: opts.limit as string | undefined,
            explain: Boolean(opts.explain),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}
