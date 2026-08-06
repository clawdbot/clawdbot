/** CLI registration for ClawHub promotional model offers. */
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerPromosCli(program: Command) {
  const promos = program
    .command("promos")
    .description("Discover and claim promotional model offers from ClawHub")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/promos", "docs.openclaw.ai/cli/promos")}\n`,
    );

  promos
    .command("list")
    .description("List active promotions")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { promosListCommand } = await import("../commands/promos/list.js");
        await promosListCommand(opts, defaultRuntime);
      });
    });

  promos
    .command("claim")
    .description("Claim a promotion: set up provider auth and register its models")
    .argument("<slug>", "Promotion slug from `openclaw promos list`")
    // Credential-on-argv matches the shipped `onboard --<provider>-api-key` /
    // `onboard --token` non-interactive contract (AGENTS.md: public API). The
    // no-argv alternative is the provider's env var, detected as existing auth.
    .option("--api-key <key>", "Provider API key for non-interactive setup")
    .option("--set-default", "Set the promotion's suggested model as default without asking", false)
    .action(async (slug: string, opts: { apiKey?: string; setDefault?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { promosClaimCommand } = await import("../commands/promos/claim.js");
        await promosClaimCommand(slug, opts, defaultRuntime);
      });
    });
}
