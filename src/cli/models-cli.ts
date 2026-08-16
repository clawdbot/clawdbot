// Commander registration for model catalog, status, auth, alias, and fallback commands.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { isModelsStatusJsonOutput } from "./models-output-mode.js";
import { setCommandJsonMode } from "./program/json-mode.js";

type ModelsCliRuntime = typeof import("./models-cli.runtime.js");

function createModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  // Model subcommands are heavy; load each implementation once on first use.
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

const loadModelsRuntime = createModuleLoader<ModelsCliRuntime>(
  () => import("./models-cli.runtime.js"),
);
const loadModelsStatusCommands = createModuleLoader(
  () => import("../commands/models/list.status-command.js"),
);
const loadModelsAliasesCommands = createModuleLoader(() => import("../commands/models/aliases.js"));
const loadModelsFallbacksCommands = createModuleLoader(
  () => import("../commands/models/fallbacks.js"),
);
const loadModelsImageFallbacksCommands = createModuleLoader(
  () => import("../commands/models/image-fallbacks.js"),
);
const loadModelsAuthCommands = createModuleLoader(() => import("../commands/models/auth.js"));
const loadModelsAuthOrderCommands = createModuleLoader(
  () => import("../commands/models/auth-order.js"),
);

async function withModelsRuntime(
  action: (runtime: ModelsCliRuntime) => Promise<void>,
): Promise<void> {
  const runtime = await loadModelsRuntime();
  return runtime.runModelsCommand(() => action(runtime));
}

export function registerModelsCli(program: Command) {
  const models = program
    .command("models")
    .description("Model discovery, scanning, and configuration")
    .option("--json", "Output JSON (alias for `models status --json`)", false)
    .option("--status-json", "Output JSON (alias for `models status --json`)", false)
    .option("--status-plain", "Plain output (alias for `models status --plain`)", false)
    .option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/models", "docs.openclaw.ai/cli/models")}\n`,
    );
  const hasJsonOutput = (opts?: { json?: boolean }): boolean =>
    Boolean(opts?.json || models.opts<{ json?: boolean }>().json);
  setCommandJsonMode(models, "output", ({ argv }) => isModelsStatusJsonOutput(argv));

  models
    .command("list")
    .description("List models (configured by default)")
    .option("--all", "Show full model catalog", false)
    .option("--local", "Filter to local models", false)
    .option("--provider <id>", "Filter by provider id")
    .option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR)")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain line output", false)
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const { modelsListCommand } = await import("../commands/models/list.list-command.js");
        await modelsListCommand(
          {
            ...opts,
            json: hasJsonOutput(opts),
            agent: resolveModelAgentOption(command, opts),
          },
          defaultRuntime,
        );
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
    .option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR)")
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsStatusCommand } = await loadModelsStatusCommands();
        await modelsStatusCommand(
          {
            json: hasJsonOutput(opts),
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
    .command("refresh")
    .description("Refresh the hosted model catalog")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await withModelsRuntime(async ({ defaultRuntime }) => {
        const { modelsRefreshCommand } = await import("../commands/models/refresh.js");
        await modelsRefreshCommand({ json: hasJsonOutput(opts) }, defaultRuntime);
      });
    });

  models
    .command("set")
    .description("Set the default model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string, _opts: unknown, command: Command) => {
      const runtime = await loadModelsRuntime();
      runtime.rejectAgentScopedModelWrite(command, "set");
      await runtime.runModelsCommand(async () => {
        const { modelsSetCommand } = await import("../commands/models/set.js");
        await modelsSetCommand(model, runtime.defaultRuntime);
      });
    });

  models
    .command("set-image")
    .description("Set the image model")
    .argument("<model>", "Model id or alias")
    .action(async (model: string, _opts: unknown, command: Command) => {
      const runtime = await loadModelsRuntime();
      runtime.rejectAgentScopedModelWrite(command, "set-image");
      await runtime.runModelsCommand(async () => {
        const { modelsSetImageCommand } = await import("../commands/models/set-image.js");
        await modelsSetImageCommand(model, runtime.defaultRuntime);
      });
    });

  const aliases = models.command("aliases").description("Manage model aliases");

  aliases
    .command("list")
    .description("List model aliases")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .action(async (opts) => {
      await withModelsRuntime(async ({ defaultRuntime }) => {
        const { modelsAliasesListCommand } = await loadModelsAliasesCommands();
        await modelsAliasesListCommand({ ...opts, json: hasJsonOutput(opts) }, defaultRuntime);
      });
    });

  aliases
    .command("add")
    .description("Add or update a model alias")
    .argument("<alias>", "Alias name")
    .argument("<model>", "Model id or alias")
    .action(async (alias: string, model: string) => {
      await withModelsRuntime(async ({ defaultRuntime }) => {
        const { modelsAliasesAddCommand } = await loadModelsAliasesCommands();
        await modelsAliasesAddCommand(alias, model, defaultRuntime);
      });
    });

  aliases
    .command("remove")
    .description("Remove a model alias")
    .argument("<alias>", "Alias name")
    .action(async (alias: string) => {
      await withModelsRuntime(async ({ defaultRuntime }) => {
        const { modelsAliasesRemoveCommand } = await loadModelsAliasesCommands();
        await modelsAliasesRemoveCommand(alias, defaultRuntime);
      });
    });

  const fallbackGroups = [
    {
      name: "fallbacks",
      modelType: "model",
      noun: "fallback",
      article: "a",
      load: async () => {
        const commands = await loadModelsFallbacksCommands();
        return {
          list: commands.modelsFallbacksListCommand,
          add: commands.modelsFallbacksAddCommand,
          remove: commands.modelsFallbacksRemoveCommand,
          clear: commands.modelsFallbacksClearCommand,
        };
      },
    },
    {
      name: "image-fallbacks",
      modelType: "image model",
      noun: "image fallback",
      article: "an",
      load: async () => {
        const commands = await loadModelsImageFallbacksCommands();
        return {
          list: commands.modelsImageFallbacksListCommand,
          add: commands.modelsImageFallbacksAddCommand,
          remove: commands.modelsImageFallbacksRemoveCommand,
          clear: commands.modelsImageFallbacksClearCommand,
        };
      },
    },
  ] as const;

  for (const { name, modelType, noun, article, load } of fallbackGroups) {
    const group = models.command(name).description(`Manage ${modelType} fallback list`);

    group
      .command("list")
      .description(`List ${noun} models`)
      .option("--json", "Output JSON", false)
      .option("--plain", "Plain output", false)
      .action(async (opts) => {
        await withModelsRuntime(async ({ defaultRuntime }) => {
          const commands = await load();
          await commands.list({ ...opts, json: hasJsonOutput(opts) }, defaultRuntime);
        });
      });

    for (const action of ["add", "remove"] as const) {
      group
        .command(action)
        .description(`${action === "add" ? "Add" : "Remove"} ${article} ${noun} model`)
        .argument("<model>", "Model id or alias")
        .action(async (model: string) => {
          await withModelsRuntime(async ({ defaultRuntime }) => {
            const commands = await load();
            await commands[action](model, defaultRuntime);
          });
        });
    }

    group
      .command("clear")
      .description(`Clear all ${noun} models`)
      .action(async () => {
        await withModelsRuntime(async ({ defaultRuntime }) => {
          const commands = await load();
          await commands.clear(defaultRuntime);
        });
      });
  }

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
      await withModelsRuntime(async ({ defaultRuntime }) => {
        const { modelsScanCommand } = await import("../commands/models/scan.js");
        await modelsScanCommand({ ...opts, json: hasJsonOutput(opts) }, defaultRuntime);
      });
    });

  models.action(async (opts) => {
    await withModelsRuntime(async ({ defaultRuntime }) => {
      const { modelsStatusCommand } = await loadModelsStatusCommands();
      await modelsStatusCommand(
        {
          json: Boolean(opts?.json || opts?.statusJson),
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
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsAuthListCommand } = await import("../commands/models/auth-list.js");
        await modelsAuthListCommand(
          {
            provider: opts.provider as string | undefined,
            agent,
            json: hasJsonOutput(opts),
          },
          defaultRuntime,
        );
      });
    });

  auth
    .command("add")
    .description("Interactive auth helper (provider auth or paste token)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsAuthAddCommand } = await loadModelsAuthCommands();
        await modelsAuthAddCommand({ agent }, defaultRuntime);
      });
    });

  auth
    .command("logout")
    .description("Remove a saved auth profile (see `models auth list` for ids)")
    .argument("<profileId>", "Auth profile id (e.g. openai:manual)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--yes", "Skip the confirmation prompt", false)
    .action(async (profileId: string, opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsAuthLogoutCommand } = await import("../commands/models/auth-logout.js");
        await modelsAuthLogoutCommand(
          {
            profileId,
            agent,
            yes: Boolean(opts.yes),
          },
          defaultRuntime,
        );
      });
    });

  auth
    .command("login")
    .description("Run a provider plugin auth flow (OAuth/API key)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--provider <id>", "Provider id registered by a plugin")
    .option("--method <id>", "Provider auth method id")
    .option("--device-code", "Use the provider device-code auth method", false)
    .option("--profile-id <id>", "Auth profile id override for single-profile login methods")
    .option("--set-default", "Apply the provider's default model recommendation", false)
    .option(
      "--force",
      "Remove existing profiles for the provider before logging in (use when a cached OAuth profile is stuck or you want to switch accounts)",
      false,
    )
    .option("--repeat", "Keep adding provider credentials until you stop", false)
    .action(async (opts, command) => {
      if (opts.deviceCode && typeof opts.method === "string" && opts.method !== "device-code") {
        throw new Error(
          "--device-code cannot be combined with --method unless method is device-code.",
        );
      }
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command);
        const { modelsAuthLoginCommand } = await loadModelsAuthCommands();
        await modelsAuthLoginCommand(
          {
            provider: opts.provider as string | undefined,
            method: opts.deviceCode ? "device-code" : (opts.method as string | undefined),
            profileId: opts.profileId as string | undefined,
            setDefault: Boolean(opts.setDefault),
            force: Boolean(opts.force),
            repeat: Boolean(opts.repeat),
            agent,
          },
          defaultRuntime,
        );
      });
    });

  auth
    .command("setup-token")
    .description("Run a provider CLI to create/sync a token (TTY required)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--provider <name>", "Provider id")
    .option("--yes", "Skip confirmation", false)
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command);
        const { modelsAuthSetupTokenCommand } = await loadModelsAuthCommands();
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
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--profile-id <id>", "Auth profile id (default: <provider>:manual)")
    .option(
      "--expires-in <duration>",
      "Optional expiry duration (e.g. 365d, 12h). Stored as absolute expiresAt.",
    )
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command);
        const { modelsAuthPasteTokenCommand } = await loadModelsAuthCommands();
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
    .command("paste-api-key")
    .description("Paste an API key into auth-profiles.json and update config")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .requiredOption("--provider <name>", "Provider id (e.g. openai)")
    .option("--profile-id <id>", "Auth profile id (default: <provider>:manual)")
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command);
        const { modelsAuthPasteApiKeyCommand } = await loadModelsAuthCommands();
        await modelsAuthPasteApiKeyCommand(
          {
            provider: opts.provider as string | undefined,
            profileId: opts.profileId as string | undefined,
            agent,
          },
          defaultRuntime,
        );
      });
    });

  auth
    .command("login-github-copilot")
    .description("Login to GitHub Copilot via GitHub device flow (TTY required)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--yes", "Overwrite existing profile without prompting", false)
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command);
        const { modelsAuthLoginCommand } = await loadModelsAuthCommands();
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
    .description("Show per-agent auth profile order override")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsAuthOrderGetCommand } = await loadModelsAuthOrderCommands();
        await modelsAuthOrderGetCommand(
          {
            provider: opts.provider as string,
            agent,
            json: hasJsonOutput(opts),
          },
          defaultRuntime,
        );
      });
    });

  order
    .command("set")
    .description("Set per-agent auth profile order override")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .argument("<profileIds...>", "Auth profile ids (e.g. anthropic:default)")
    .action(async (profileIds: string[], opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsAuthOrderSetCommand } = await loadModelsAuthOrderCommands();
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
    .description("Clear per-agent auth profile order override")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const agent = resolveModelAgentOption(command, opts);
        const { modelsAuthOrderClearCommand } = await loadModelsAuthOrderCommands();
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
