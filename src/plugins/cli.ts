import type { Command } from "commander";
import { getRuntimeConfig, readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLogger,
  loadPluginCliDescriptors,
  loadPluginCliRegistrationEntriesWithDefaults,
  type PluginCliLoaderOptions,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
};

type PluginCliRegistrationEntries = Awaited<
  ReturnType<typeof loadPluginCliRegistrationEntriesWithDefaults>
>;

const PLUGIN_CLI_ENTRIES_CACHE_KEY = Symbol.for("openclaw.plugin-cli-registration-entries-cache");

interface ProgramWithEntriesCache {
  [PLUGIN_CLI_ENTRIES_CACHE_KEY]?: {
    primary: string | undefined;
    entries: PluginCliRegistrationEntries;
  };
}

const logger = createPluginCliLogger();

export const loadValidatedConfigForPluginRegistration =
  async (): Promise<OpenClawConfig | null> => {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return null;
    }
    return getRuntimeConfig();
  };

export async function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<OpenClawPluginCliCommandDescriptor[]> {
  return loadPluginCliDescriptors({ cfg, env, loaderOptions });
}

export async function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
) {
  const mode = options?.mode ?? "eager";
  const primary = options?.primary ?? undefined;

  const programWithCache = program as Command & ProgramWithEntriesCache;
  const cached = programWithCache[PLUGIN_CLI_ENTRIES_CACHE_KEY];
  let entries: PluginCliRegistrationEntries;
  if (cached && cached.primary === primary) {
    entries = cached.entries;
  } else {
    entries = await loadPluginCliRegistrationEntriesWithDefaults({
      cfg,
      env,
      loaderOptions,
      primaryCommand: primary,
    });
    programWithCache[PLUGIN_CLI_ENTRIES_CACHE_KEY] = { primary, entries };
  }

  await registerPluginCliCommandGroups(program, entries, {
    mode,
    primary,
    existingCommands: new Set(program.commands.map((cmd) => cmd.name())),
    logger,
  });
}

export async function registerPluginCliCommandsFromValidatedConfig(
  program: Command,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig | null> {
  const config = await loadValidatedConfigForPluginRegistration();
  if (!config) {
    return null;
  }
  await registerPluginCliCommands(program, config, env, loaderOptions, options);
  return config;
}
