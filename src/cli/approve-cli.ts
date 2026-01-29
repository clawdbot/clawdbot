import type { Command } from "commander";

import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

type ApproveDecision = "allow-once" | "allow-always" | "deny";

const DECISION_ALIASES: Record<string, ApproveDecision> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

function normalizeDecision(raw: string): ApproveDecision | null {
  return DECISION_ALIASES[raw.toLowerCase().trim()] ?? null;
}

type ApproveCliOpts = {
  url?: string;
  token?: string;
  timeout?: string;
};

export function registerApproveCli(program: Command) {
  program
    .command("approve <id> <decision>")
    .description("Resolve an exec approval request")
    .option("--url <url>", "Gateway WebSocket URL")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Decisions:")}\n` +
        `  ${theme.command("allow-once")}   Allow once (aliases: allow, once)\n` +
        `  ${theme.command("allow-always")} Allow always and add to allowlist (aliases: always)\n` +
        `  ${theme.command("deny")}         Deny the request (aliases: reject, block)\n` +
        `\n${theme.heading("Examples:")}\n` +
        `  ${theme.command("moltmate approve abc123 allow-once")}\n` +
        `  ${theme.command("moltmate approve abc123 always")}\n` +
        `  ${theme.command("moltmate approve abc123 deny")}\n` +
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approve", "docs.clawd.bot/cli/approve")}\n`,
    )
    .action(async (id: string, decision: string, opts: ApproveCliOpts) => {
      const trimmedId = id.trim();
      if (!trimmedId) {
        defaultRuntime.error("Approval ID is required.");
        defaultRuntime.exit(1);
        return;
      }

      const normalizedDecision = normalizeDecision(decision);
      if (!normalizedDecision) {
        defaultRuntime.error(
          `Invalid decision "${decision}". Use: allow-once, allow-always, or deny`,
        );
        defaultRuntime.exit(1);
        return;
      }

      try {
        await callGateway({
          url: opts.url,
          token: opts.token,
          method: "exec.approval.resolve",
          params: { id: trimmedId, decision: normalizedDecision },
          timeoutMs: Number(opts.timeout ?? 10_000),
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          clientDisplayName: "CLI approve command",
          mode: GATEWAY_CLIENT_MODES.CLI,
        });

        defaultRuntime.log(`✅ Exec approval ${normalizedDecision} submitted for ${trimmedId}.`);
      } catch (err) {
        defaultRuntime.error(`❌ Failed to submit approval: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });
}
