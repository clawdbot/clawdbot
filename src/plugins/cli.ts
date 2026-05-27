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
import type { OpenClawPluginCliCommandDescriptor, PluginLogger } from "./types.js";

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
    inputKey: string;
    entries: PluginCliRegistrationEntries;
  };
}

const logger = createPluginCliLogger();
const loaderOptionIds = new WeakMap<object, number>();
let nextLoaderOptionId = 1;

const quietDescriptorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} satisfies PluginLogger;

function stableJsonKey(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      return Object.fromEntries(
        Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)),
      );
    });
  } catch {
    return "unserializable";
  }
}

function loaderOptionsKey(loaderOptions: PluginCliLoaderOptions | undefined): string {
  if (!loaderOptions) {
    return "undefined";
  }
  const existing = loaderOptionIds.get(loaderOptions);
  if (existing) {
    return String(existing);
  }
  const id = nextLoaderOptionId;
  nextLoaderOptionId += 1;
  loaderOptionIds.set(loaderOptions, id);
  return String(id);
}

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
  return loadPluginCliDescriptors({ cfg, env, loaderOptions, logger: quietDescriptorLogger });
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
  const inputKey = [stableJsonKey(cfg), stableJsonKey(env), loaderOptionsKey(loaderOptions)].join(
    "\0",
  );

  const programWithCache = program as Command & ProgramWithEntriesCache;
  const cached = programWithCache[PLUGIN_CLI_ENTRIES_CACHE_KEY];
  let entries: PluginCliRegistrationEntries;
  if (cached && cached.primary === primary && cached.inputKey === inputKey) {
    entries = cached.entries;
  } else {
    entries = await loadPluginCliRegistrationEntriesWithDefaults({
      cfg,
      env,
      loaderOptions,
      primaryCommand: primary,
    });
    programWithCache[PLUGIN_CLI_ENTRIES_CACHE_KEY] = { primary, inputKey, entries };
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
