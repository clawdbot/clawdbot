import type { Command } from "commander";

import {
  githubCopilotLoginCommand,
  modelsAliasesAddCommand,
  modelsAliasesListCommand,
  modelsAliasesRemoveCommand,
  modelsAuthAddCommand,
  modelsAuthOrderClearCommand,
  modelsAuthOrderGetCommand,
  modelsAuthOrderSetCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  modelsFallbacksAddCommand,
  modelsFallbacksClearCommand,
  modelsFallbacksListCommand,
  modelsFallbacksRemoveCommand,
  modelsImageFallbacksAddCommand,
  modelsImageFallbacksClearCommand,
  modelsImageFallbacksListCommand,
  modelsImageFallbacksRemoveCommand,
  modelsListCommand,
  modelsScanCommand,
  modelsSetCommand,
  modelsSetImageCommand,
  modelsStatusCommand,
} from "../commands/models.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerModelsCli(program: Command) {
  const models = program
    .command("models")
    .description("Model discovery, scanning, and configuration")
    .option(
      "--status-json",
      "Output JSON (alias for `models status --json`)",
      false,
    )
    .option(
      "--status-plain",
      "Plain output (alias for `models status --plain`)",
      false,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/models",
          "docs.clawd.bot/models",
        )}\n`,
    );

  models
    .command("list")
    .description("List models (configured by default)")
    .option("--all", "Show full model catalog", false)
    .option("--local", "Filter to local models", false)
    .option("--provider <name>", "Filter by provider")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain line output", false)
    .action(async (opts) => {
      try {
        await modelsListCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  models
    .command("status")
    .description("Show configured model state")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .option(
      "--check",
      "Exit non-zero if auth is expiring/expired (1=expired/missing, 2=expiring)",
      false,
    )
    .action(async (opts) => {
      try {
        await modelsStatusCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  models
    .command("set")
    .description("Set the default model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      try {
        await modelsSetCommand(model, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  models
    .command("set-image")
    .description("Set the image model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      try {
        await modelsSetImageCommand(model, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  const aliases = models.command("aliases").description("Manage model aliases");

  aliases
    .command("list")
    .description("List model aliases")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .action(async (opts) => {
      try {
        await modelsAliasesListCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  aliases
    .command("add")
    .description("Add or update a model alias")
    .argument("<alias>", "Alias name")
    .argument("<model>", "Model id or alias")
    .action(async (alias: string, model: string) => {
      try {
        await modelsAliasesAddCommand(alias, model, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  aliases
    .command("remove")
    .description("Remove a model alias")
    .argument("<alias>", "Alias name")
    .action(async (alias: string) => {
      try {
        await modelsAliasesRemoveCommand(alias, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  const fallbacks = models
    .command("fallbacks")
    .description("Manage model fallback list");

  fallbacks
    .command("list")
    .description("List fallback models")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .action(async (opts) => {
      try {
        await modelsFallbacksListCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  fallbacks
    .command("add")
    .description("Add a fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      try {
        await modelsFallbacksAddCommand(model, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  fallbacks
    .command("remove")
    .description("Remove a fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      try {
        await modelsFallbacksRemoveCommand(model, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  fallbacks
    .command("clear")
    .description("Clear all fallback models")
    .action(async () => {
      try {
        await modelsFallbacksClearCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  const imageFallbacks = models
    .command("image-fallbacks")
    .description("Manage image model fallback list");

  imageFallbacks
    .command("list")
    .description("List image fallback models")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .action(async (opts) => {
      try {
        await modelsImageFallbacksListCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  imageFallbacks
    .command("add")
    .description("Add an image fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      try {
        await modelsImageFallbacksAddCommand(model, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  imageFallbacks
    .command("remove")
    .description("Remove an image fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      try {
        await modelsImageFallbacksRemoveCommand(model, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  imageFallbacks
    .command("clear")
    .description("Clear all image fallback models")
    .action(async () => {
      try {
        await modelsImageFallbacksClearCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  models
    .command("scan")
    .description("Scan OpenRouter free models for tools + images")
    .option("--min-params <b>", "Minimum parameter size (billions)")
    .option("--max-age-days <days>", "Skip models older than N days")
    .option("--provider <name>", "Filter by provider prefix")
    .option("--max-candidates <n>", "Max fallback candidates", "6")
    .option("--timeout <ms>", "Per-probe timeout in ms")
    .option("--concurrency <n>", "Probe concurrency")
    .option("--no-probe", "Skip live probes; list free candidates only")
    .option("--yes", "Accept defaults without prompting", false)
    .option("--no-input", "Disable prompts (use defaults)")
    .option(
      "--set-default",
      "Set agents.defaults.model to the first selection",
      false,
    )
    .option(
      "--set-image",
      "Set agents.defaults.imageModel to the first image selection",
      false,
    )
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await modelsScanCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  models.action(async (opts) => {
    try {
      await modelsStatusCommand(
        {
          json: Boolean(opts?.statusJson),
          plain: Boolean(opts?.statusPlain),
        },
        defaultRuntime,
      );
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  const auth = models.command("auth").description("Manage model auth profiles");

  auth
    .command("add")
    .description("Interactive auth helper (setup-token or paste token)")
    .action(async () => {
      try {
        await modelsAuthAddCommand({}, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  auth
    .command("setup-token")
    .description("Run a provider CLI to create/sync a token (TTY required)")
    .option("--provider <name>", "Provider id (default: anthropic)")
    .option("--yes", "Skip confirmation", false)
    .action(async (opts) => {
      try {
        await modelsAuthSetupTokenCommand(
          {
            provider: opts.provider as string | undefined,
            yes: Boolean(opts.yes),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  auth
    .command("paste-token")
    .description("Paste a token into auth-profiles.json and update config")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--profile-id <id>", "Auth profile id (default: <provider>:manual)")
    .option(
      "--expires-in <duration>",
      "Optional expiry duration (e.g. 365d, 12h). Stored as absolute expiresAt.",
    )
    .action(async (opts) => {
      try {
        await modelsAuthPasteTokenCommand(
          {
            provider: opts.provider as string | undefined,
            profileId: opts.profileId as string | undefined,
            expiresIn: opts.expiresIn as string | undefined,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  auth
    .command("login-github-copilot")
    .description(
      "Login to GitHub Copilot via GitHub device flow (TTY required)",
    )
    .option(
      "--profile-id <id>",
      "Auth profile id (default: github-copilot:github)",
    )
    .option("--yes", "Overwrite existing profile without prompting", false)
    .action(async (opts) => {
      try {
        await githubCopilotLoginCommand(
          {
            profileId: opts.profileId as string | undefined,
            yes: Boolean(opts.yes),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  const order = auth
    .command("order")
    .description("Manage per-agent auth profile order overrides");

  order
    .command("get")
    .description("Show per-agent auth order override (from auth-profiles.json)")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await modelsAuthOrderGetCommand(
          {
            provider: opts.provider as string,
            agent: opts.agent as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  order
    .command("set")
    .description(
      "Set per-agent auth order override (locks rotation to this list)",
    )
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .argument("<profileIds...>", "Auth profile ids (e.g. anthropic:claude-cli)")
    .action(async (profileIds: string[], opts) => {
      try {
        await modelsAuthOrderSetCommand(
          {
            provider: opts.provider as string,
            agent: opts.agent as string | undefined,
            order: profileIds,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  order
    .command("clear")
    .description(
      "Clear per-agent auth order override (fall back to config/round-robin)",
    )
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .action(async (opts) => {
      try {
        await modelsAuthOrderClearCommand(
          {
            provider: opts.provider as string,
            agent: opts.agent as string | undefined,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
