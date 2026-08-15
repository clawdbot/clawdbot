// Top-level model auth shortcuts.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";

type ModelsCliRuntime = typeof import("./models-cli.runtime.js");

function createModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

const loadModelsRuntime = createModuleLoader<ModelsCliRuntime>(
  () => import("./models-cli.runtime.js"),
);

async function withModelsRuntime(
  action: (runtime: ModelsCliRuntime) => Promise<void>,
): Promise<void> {
  const runtime = await loadModelsRuntime();
  return runtime.runModelsCommand(() => action(runtime));
}

export function registerAuthCli(program: Command) {
  const auth = program
    .command("auth")
    .description("Model auth profile shortcuts")
    .option("--agent <id>", "Agent id for auth commands")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/models", "docs.openclaw.ai/cli/models")}\n`,
    );

  auth.action(() => {
    auth.help();
  });

  auth
    .command("list")
    .description("List saved model auth profiles")
    .option("--provider <id>", "Filter by provider id")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsAuthListCommand } = await import("../commands/models/auth-list.js");
        await modelsAuthListCommand(
          {
            provider: opts.provider as string | undefined,
            agent,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}
