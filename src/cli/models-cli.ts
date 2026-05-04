import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveOptionFromCommand, runCommandWithRuntime } from "./cli-utils.js";

function runModelsCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

function rejectAgentScopedModelWrite(command: Command, commandName: "set" | "set-image"): void {
  const agent = resolveOptionFromCommand<string>(command, "agent");
  if (!agent) {
    return;
  }
  throw new Error(
    `\`openclaw models ${commandName}\` does not support \`--agent\`; it only updates global model defaults. Remove \`--agent\` or use agent config to set a per-agent model override.`,
  );
}

export function registerModelsCli(program: Command) {
  const models = program
    .command("models")
    .description("Model discovery, scanning, and configuration")
    .option("--status-json", "Output JSON (alias for `models status --json`)", false)
    .option("--status-plain", "Plain output (alias for `models status --plain`)", false)
    .option(
      "--agent <id>",
      "Agent id to inspect (overrides OPENCLAW_AGENT_DIR/PI_CODING_AGENT_DIR)",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/models", "docs.openclaw.ai/cli/models")}\n`,
    );

  models
    .command("list")
    .description("List models (configured by default)")
    .option("--all", "Show full model catalog", false)
    .option("--local", "Filter to local models", false)
    .option("--provider <id>", "Filter by provider id")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain line output", false)
    .action(async (opts) => {
      await runModelsCommand(async () => {
        const { modelsListCommand } = await import("../commands/models/list.list-command.js");
        await modelsListCommand(opts, defaultRuntime);
      });
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
    .option("--probe", "Probe configured provider auth (live)", false)
    .option("--probe-provider <name>", "Only probe a single provider")
    .option(
      "--probe-profile <id>",
      "Only probe specific auth profile ids (repeat or comma-separated)",
      (value, previous) => {
        const next = Array.isArray(previous) ? previous : previous ? [previous] : [];
        next.push(value);
        return next;
      },
    )
    .option("--probe-timeout <ms>", "Per-probe timeout in ms")
    .option("--probe-concurrency <n>", "Concurrent probes")
    .option("--probe-max-tokens <n>", "Probe max tokens (best-effort)")
    .option(
      "--agent <id>",
      "Agent id to inspect (overrides OPENCLAW_AGENT_DIR/PI_CODING_AGENT_DIR)",
    )
    .action(async (opts, command) => {
      const agent =
        resolveOptionFromCommand<string>(command, "agent") ?? (opts.agent as string | undefined);
      await runModelsCommand(async () => {
        const { modelsStatusCommand } = await import("../commands/models/list.status-command.js");
        await modelsStatusCommand(
          {
            json: Boolean(opts.json),
            plain: Boolean(opts.plain),
            check: Boolean(opts.check),
            probe: Boolean(opts.probe),
            probeProvider: opts.probeProvider as string | undefined,
            probeProfile: opts.probeProfile as string | string[] | undefined,
            probeTimeout: opts.probeTimeout as string | undefined,
            probeConcurrency: opts.probeConcurrency as string | undefined,
            probeMaxTokens: opts.probeMaxTokens as string | undefined,
            agent,
          },
          defaultRuntime,
        );
      });
    });

  models
    .command("set")
    .description("Set the default model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string, _opts: unknown, command: Command) => {
      rejectAgentScopedModelWrite(command, "set");
      await runModelsCommand(async () => {
        const { modelsSetCommand } = await import("../commands/models/set.js");
        await modelsSetCommand(model, defaultRuntime);
      });
    });

  models
    .command("set-image")
    .description("Set the image model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string, _opts: unknown, command: Command) => {
      rejectAgentScopedModelWrite(command, "set-image");
      await runModelsCommand(async () => {
        const { modelsSetImageCommand } = await import("../commands/models/set-image.js");
        await modelsSetImageCommand(model, defaultRuntime);
      });
    });

  const aliases = models.command("aliases").description("Manage model aliases");

  aliases
    .command("list")
    .description("List model aliases")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .action(async (opts) => {
      await runModelsCommand(async () => {
        const { modelsAliasesListCommand } = await import("../commands/models/aliases.js");
        await modelsAliasesListCommand(opts, defaultRuntime);
      });
    });

  aliases
    .command("add")
    .description("Add or update a model alias")
    .argument("<alias>", "Alias name")
    .argument("<model>", "Model id or alias")
    .action(async (alias: string, model: string) => {
      await runModelsCommand(async () => {
        const { modelsAliasesAddCommand } = await import("../commands/models/aliases.js");
        await modelsAliasesAddCommand(alias, model, defaultRuntime);
      });
    });

  aliases
    .command("remove")
    .description("Remove a model alias")
    .argument("<alias>", "Alias name")
    .action(async (alias: string) => {
      await runModelsCommand(async () => {
        const { modelsAliasesRemoveCommand } = await import("../commands/models/aliases.js");
        await modelsAliasesRemoveCommand(alias, defaultRuntime);
      });
    });

  const fallbacks = models.command("fallbacks").description("Manage model fallback list");

  fallbacks
    .command("list")
    .description("List fallback models")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .action(async (opts) => {
      await runModelsCommand(async () => {
        const { modelsFallbacksListCommand } = await import("../commands/models/fallbacks.js");
        await modelsFallbacksListCommand(opts, defaultRuntime);
      });
    });

  fallbacks
    .command("add")
    .description("Add a fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      await runModelsCommand(async () => {
        const { modelsFallbacksAddCommand } = await import("../commands/models/fallbacks.js");
        await modelsFallbacksAddCommand(model, defaultRuntime);
      });
    });

  fallbacks
    .command("remove")
    .description("Remove a fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      await runModelsCommand(async () => {
        const { modelsFallbacksRemoveCommand } = await import("../commands/models/fallbacks.js");
        await modelsFallbacksRemoveCommand(model, defaultRuntime);
      });
    });

  fallbacks
    .command("clear")
    .description("Clear all fallback models")
    .action(async () => {
      await runModelsCommand(async () => {
        const { modelsFallbacksClearCommand } = await import("../commands/models/fallbacks.js");
        await modelsFallbacksClearCommand(defaultRuntime);
      });
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
      await runModelsCommand(async () => {
        const { modelsImageFallbacksListCommand } =
          await import("../commands/models/image-fallbacks.js");
        await modelsImageFallbacksListCommand(opts, defaultRuntime);
      });
    });

  imageFallbacks
    .command("add")
    .description("Add an image fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      await runModelsCommand(async () => {
        const { modelsImageFallbacksAddCommand } =
          await import("../commands/models/image-fallbacks.js");
        await modelsImageFallbacksAddCommand(model, defaultRuntime);
      });
    });

  imageFallbacks
    .command("remove")
    .description("Remove an image fallback model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string) => {
      await runModelsCommand(async () => {
        const { modelsImageFallbacksRemoveCommand } =
          await import("../commands/models/image-fallbacks.js");
        await modelsImageFallbacksRemoveCommand(model, defaultRuntime);
      });
    });

  imageFallbacks
    .command("clear")
    .description("Clear all image fallback models")
    .action(async () => {
      await runModelsCommand(async () => {
        const { modelsImageFallbacksClearCommand } =
          await import("../commands/models/image-fallbacks.js");
        await modelsImageFallbacksClearCommand(defaultRuntime);
      });
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
    .option("--set-default", "Set agents.defaults.model to the first selection", false)
    .option("--set-image", "Set agents.defaults.imageModel to the first image selection", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runModelsCommand(async () => {
        const { modelsScanCommand } = await import("../commands/models/scan.js");
        await modelsScanCommand(opts, defaultRuntime);
      });
    });

  models.action(async (opts) => {
    await runModelsCommand(async () => {
      const { modelsStatusCommand } = await import("../commands/models/list.status-command.js");
      await modelsStatusCommand(
        {
          json: Boolean(opts?.statusJson),
          plain: Boolean(opts?.statusPlain),
          agent: opts?.agent as string | undefined,
        },
        defaultRuntime,
      );
    });
  });

  const auth = models.command("auth").description("Manage model auth profiles");
  auth.option("--agent <id>", "Agent id for auth commands");
  auth.action(() => {
    auth.help();
  });

  auth
    .command("list")
    .description("List saved auth profiles")
    .option("--provider <id>", "Filter by provider id")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      const agent =
        resolveOptionFromCommand<string>(command, "agent") ?? (opts.agent as string | undefined);
      await runModelsCommand(async () => {
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

  auth
    .command("add")
    .description("Interactive auth helper (provider auth or paste token)")
    .action(async (command) => {
      const agent =
        resolveOptionFromCommand<string>(command, "agent") ??
        resolveOptionFromCommand<string>(auth, "agent");
      await runModelsCommand(async () => {
        const { modelsAuthAddCommand } = await import("../commands/models/auth.js");
        await modelsAuthAddCommand({ agent }, defaultRuntime);
      });
    });

  auth
    .command("login")
    .description("Run a provider plugin auth flow (OAuth/API key)")
    .option("--provider <id>", "Provider id registered by a plugin")
    .option("--method <id>", "Provider auth method id")
    .option("--set-default", "Apply the provider's default model recommendation", false)
    .action(async (opts, command) => {
      const agent = resolveOptionFromCommand<string>(command, "agent");
      await runModelsCommand(async () => {
        const { modelsAuthLoginCommand } = await import("../commands/models/auth.js");
        await modelsAuthLoginCommand(
          {
            provider: opts.provider as string | undefined,
            method: opts.method as string | undefined,
            setDefault: Boolean(opts.setDefault),
            agent,
          },
          defaultRuntime,
        );
      });
    });

  auth
    .command("setup-token")
    .description("Run a provider CLI to create/sync a token (TTY required)")
    .option("--provider <name>", "Provider id")
    .option("--yes", "Skip confirmation", false)
    .action(async (opts, command) => {
      const agent = resolveOptionFromCommand<string>(command, "agent");
      await runModelsCommand(async () => {
        const { modelsAuthSetupTokenCommand } = await import("../commands/models/auth.js");
        await modelsAuthSetupTokenCommand(
          {
            provider: opts.provider as string | undefined,
            yes: Boolean(opts.yes),
            agent,
          },
          defaultRuntime,
        );
      });
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
    .action(async (opts, command) => {
      const agent = resolveOptionFromCommand<string>(command, "agent");
      await runModelsCommand(async () => {
        const { modelsAuthPasteTokenCommand } = await import("../commands/models/auth.js");
        await modelsAuthPasteTokenCommand(
          {
            provider: opts.provider as string | undefined,
            profileId: opts.profileId as string | undefined,
            expiresIn: opts.expiresIn as string | undefined,
            agent,
          },
          defaultRuntime,
        );
      });
    });

  auth
    .command("login-github-copilot")
    .description("Login to GitHub Copilot via GitHub device flow (TTY required)")
    .option("--yes", "Overwrite existing profile without prompting", false)
    .action(async (opts, command) => {
      const agent = resolveOptionFromCommand<string>(command, "agent");
      await runModelsCommand(async () => {
        const { modelsAuthLoginCommand } = await import("../commands/models/auth.js");
        await modelsAuthLoginCommand(
          {
            provider: "github-copilot",
            method: "device",
            yes: Boolean(opts.yes),
            agent,
          },
          defaultRuntime,
        );
      });
    });

  const order = auth.command("order").description("Manage per-agent auth profile order overrides");

  order
    .command("get")
    .description("Show per-agent auth order override (from auth-state.json)")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      const agent =
        resolveOptionFromCommand<string>(command, "agent") ?? (opts.agent as string | undefined);
      await runModelsCommand(async () => {
        const { modelsAuthOrderGetCommand } = await import("../commands/models/auth-order.js");
        await modelsAuthOrderGetCommand(
          {
            provider: opts.provider as string,
            agent,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  order
    .command("set")
    .description("Set per-agent auth order override (writes auth-state.json)")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .argument("<profileIds...>", "Auth profile ids (e.g. anthropic:default)")
    .action(async (profileIds: string[], opts, command) => {
      const agent =
        resolveOptionFromCommand<string>(command, "agent") ?? (opts.agent as string | undefined);
      await runModelsCommand(async () => {
        const { modelsAuthOrderSetCommand } = await import("../commands/models/auth-order.js");
        await modelsAuthOrderSetCommand(
          {
            provider: opts.provider as string,
            agent,
            order: profileIds,
          },
          defaultRuntime,
        );
      });
    });

  order
    .command("clear")
    .description("Clear per-agent auth order override (fall back to config/round-robin)")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .action(async (opts, command) => {
      const agent =
        resolveOptionFromCommand<string>(command, "agent") ?? (opts.agent as string | undefined);
      await runModelsCommand(async () => {
        const { modelsAuthOrderClearCommand } = await import("../commands/models/auth-order.js");
        await modelsAuthOrderClearCommand(
          {
            provider: opts.provider as string,
            agent,
          },
          defaultRuntime,
        );
      });
    });
}
