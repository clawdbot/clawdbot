import type { Command } from "commander";
import type { ModelsAccountsOptions } from "../commands/models/accounts.js";
import { inheritOptionFromParent } from "./command-options.js";

function addAccountOptions(command: Command): Command {
  return command
    .option("--url <url>", "Gateway WebSocket URL (defaults to the configured Gateway)")
    .option("--port <port>", "Local Gateway port")
    .option("--token-file <path>", "Read the Gateway token from a file")
    .option("--password-file <path>", "Read the Gateway password from a file")
    .option("--timeout <ms>", "Gateway connection and request timeout in ms", "30000")
    .option("--json", "Output JSON", false);
}

function resolveAccountOptions(command: Command): ModelsAccountsOptions {
  const options = command.opts<ModelsAccountsOptions>();
  const resolve = <K extends keyof ModelsAccountsOptions>(key: K): ModelsAccountsOptions[K] =>
    inheritOptionFromParent<ModelsAccountsOptions[K]>(command, key) ?? options[key];
  return {
    url: resolve("url"),
    port: resolve("port"),
    tokenFile: resolve("tokenFile"),
    passwordFile: resolve("passwordFile"),
    timeout: resolve("timeout"),
    json: resolve("json"),
  };
}

export function registerModelsAccountsCli(models: Command): void {
  const accounts = addAccountOptions(
    models.command("accounts").description("Manage your personal model accounts on the Gateway"),
  ).addHelpText(
    "after",
    "\nPersonal accounts belong to your signed-in person, not an agent. New sessions use the selected default; existing sessions keep their account. Shared credentials remain under `models auth`.\n",
  );
  accounts.action(() => accounts.help());

  const run = async (
    command: Command,
    action: (
      commands: typeof import("../commands/models/accounts.js"),
      runtime: typeof import("./models-cli.runtime.js"),
      options: ModelsAccountsOptions,
    ) => Promise<void>,
  ) => {
    const runtime = await import("./models-cli.runtime.js");
    await runtime.runModelsCommand(async () => {
      if (runtime.resolveModelAgentOption(command) !== undefined) {
        throw new Error(
          "`models accounts` does not support --agent; it uses your signed-in Gateway person.",
        );
      }
      const commands = await import("../commands/models/accounts.js");
      await action(commands, runtime, resolveAccountOptions(command));
    });
  };

  addAccountOptions(accounts.command("list").description("List one page of your saved accounts"))
    .option("--cursor <cursor>", "Continue from nextCursor in the previous page")
    .action(async (opts: { cursor?: string }, command: Command) => {
      await run(command, (commands, runtime, options) =>
        commands.modelsAccountsListCommand(
          { ...options, cursor: opts.cursor },
          runtime.defaultRuntime,
        ),
      );
    });

  addAccountOptions(
    accounts
      .command("login [provider]")
      .description("Add a personal account using this Gateway's provider and sign-in methods"),
  )
    .option("--method <id>", "Choose a sign-in method instead of prompting")
    .action(async (provider: string | undefined, opts: { method?: string }, command: Command) => {
      await run(command, (commands, runtime, options) =>
        commands.modelsAccountsLoginCommand(
          { ...options, provider, method: opts.method },
          runtime.defaultRuntime,
        ),
      );
    });

  addAccountOptions(
    accounts
      .command("use <account-id>")
      .description("Select one of your accounts for new sessions"),
  ).action(async (authProfileId: string, _opts: unknown, command: Command) => {
    await run(command, (commands, runtime, options) =>
      commands.modelsAccountsUseCommand({ ...options, authProfileId }, runtime.defaultRuntime),
    );
  });

  addAccountOptions(
    accounts
      .command("clear-default <provider>")
      .description(
        "Clear a personal default without deleting credentials or changing existing sessions",
      ),
  ).action(async (provider: string, _opts: unknown, command: Command) => {
    await run(command, (commands, runtime, options) =>
      commands.modelsAccountsClearDefaultCommand({ ...options, provider }, runtime.defaultRuntime),
    );
  });
}
