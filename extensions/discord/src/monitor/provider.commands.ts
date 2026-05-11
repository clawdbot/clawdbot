import {
  listNativeCommandSpecsForConfig,
  listSkillCommandsForAgents,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { danger, warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type GetPluginCommandSpecs =
  typeof import("openclaw/plugin-sdk/plugin-runtime").getPluginCommandSpecs;

let pluginRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/plugin-runtime")> | undefined;

async function loadPluginRuntime() {
  const promise = pluginRuntimePromise ?? import("openclaw/plugin-sdk/plugin-runtime");
  pluginRuntimePromise = promise;
  try {
    return await promise;
  } catch (error) {
    if (pluginRuntimePromise === promise) {
      pluginRuntimePromise = undefined;
    }
    throw error;
  }
}

async function appendPluginCommandSpecs(params: {
  commandSpecs: NativeCommandSpec[];
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  getPluginCommandSpecs?: GetPluginCommandSpecs;
}): Promise<NativeCommandSpec[]> {
  const merged = [...params.commandSpecs];
  const existingNames = new Set(
    merged.map((spec) => normalizeLowercaseStringOrEmpty(spec.name)).filter(Boolean),
  );
  const getPluginCommandSpecs =
    params.getPluginCommandSpecs ?? (await loadPluginRuntime()).getPluginCommandSpecs;
  for (const pluginCommand of getPluginCommandSpecs("discord", { config: params.cfg })) {
    const normalizedName = normalizeLowercaseStringOrEmpty(pluginCommand.name);
    if (!normalizedName) {
      continue;
    }
    if (existingNames.has(normalizedName)) {
      params.runtime.error?.(
        danger(
          `discord: plugin command "/${normalizedName}" duplicates an existing native command. Skipping.`,
        ),
      );
      continue;
    }
    existingNames.add(normalizedName);
    merged.push({
      name: pluginCommand.name,
      description: pluginCommand.description,
      acceptsArgs: pluginCommand.acceptsArgs,
    });
  }
  return merged;
}

export async function resolveDiscordProviderCommandSpecs(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  maxDiscordCommands?: number;
  listSkillCommandsForAgents?: typeof listSkillCommandsForAgents;
  listNativeCommandSpecsForConfig?: typeof listNativeCommandSpecsForConfig;
  getPluginCommandSpecs?: GetPluginCommandSpecs;
}): Promise<{
  skillCommands: ReturnType<typeof listSkillCommandsForAgents>;
  commandSpecs: NativeCommandSpec[];
}> {
  const listSkillCommands = params.listSkillCommandsForAgents ?? listSkillCommandsForAgents;
  const listNativeCommandSpecs =
    params.listNativeCommandSpecsForConfig ?? listNativeCommandSpecsForConfig;
  const maxDiscordCommands = params.maxDiscordCommands ?? 100;
  let skillCommands =
    params.nativeEnabled && params.nativeSkillsEnabled
      ? listSkillCommands({ cfg: params.cfg })
      : [];
  let commandSpecs = params.nativeEnabled
    ? listNativeCommandSpecs(params.cfg, {
        skillCommands,
        provider: "discord",
      })
    : [];
  if (params.nativeEnabled) {
    commandSpecs = await appendPluginCommandSpecs({
      commandSpecs,
      runtime: params.runtime,
      cfg: params.cfg,
      getPluginCommandSpecs: params.getPluginCommandSpecs,
    });
  }
  const initialCommandCount = commandSpecs.length;
  if (
    params.nativeEnabled &&
    params.nativeSkillsEnabled &&
    commandSpecs.length > maxDiscordCommands
  ) {
    skillCommands = [];
    commandSpecs = listNativeCommandSpecs(params.cfg, {
      skillCommands: [],
      provider: "discord",
    });
    commandSpecs = await appendPluginCommandSpecs({
      commandSpecs,
      runtime: params.runtime,
      cfg: params.cfg,
      getPluginCommandSpecs: params.getPluginCommandSpecs,
    });
    params.runtime.log?.(
      warn(
        `discord: ${initialCommandCount} commands exceeds limit; removing per-skill commands and keeping /skill.`,
      ),
    );
  }
  if (params.nativeEnabled && commandSpecs.length > maxDiscordCommands) {
    params.runtime.log?.(
      warn(
        `discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`,
      ),
    );
  }
  return { skillCommands, commandSpecs };
}
