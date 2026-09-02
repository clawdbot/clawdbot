// Discord plugin module resolves model picker component state against current runtime data.
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  type ChatCommandDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createDiscordModelPickerModelToken,
  getDiscordModelPickerRuntimeChoices,
  resolveDiscordModelPickerRuntimeSelectionValue,
  type DiscordModelPickerState,
} from "./model-picker.state.js";

function listDiscordModelPickerProviderModels(
  data: ModelsProviderData,
  provider: string,
): string[] {
  const modelSet = data.byProvider.get(provider);
  if (!modelSet) {
    return [];
  }
  // Legacy index callbacks depend on JavaScript's original UTF-16 code-unit ordering.
  return [...modelSet].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function resolveDiscordModelPickerModelRefByToken(
  data: ModelsProviderData,
  modelToken: string,
): string | null {
  const matchingRefs: string[] = [];
  for (const [provider, models] of data.byProvider) {
    for (const model of models) {
      if (createDiscordModelPickerModelToken(provider, model) === modelToken) {
        matchingRefs.push(`${provider}/${model}`);
      }
    }
  }
  return matchingRefs.length === 1 ? (matchingRefs[0] ?? null) : null;
}

export function resolveDiscordModelPickerModelIndex(params: {
  data: ModelsProviderData;
  provider: string;
  model: string;
}): number | null {
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  const index = models.indexOf(params.model);
  return index < 0 ? null : index + 1;
}

export function resolveDiscordModelPickerModelSelection(params: {
  data: ModelsProviderData;
  provider: string;
  modelIndex?: number;
  modelToken?: string;
  requireModelToken?: boolean;
}): string | null {
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  if (params.modelToken) {
    const matchingModels = models.filter(
      (model) => createDiscordModelPickerModelToken(params.provider, model) === params.modelToken,
    );
    return matchingModels.length === 1 ? (matchingModels[0] ?? null) : null;
  }
  if (params.requireModelToken || !params.modelIndex || params.modelIndex < 1) {
    return null;
  }
  return models[params.modelIndex - 1] ?? null;
}

export function resolveSubmittedModelRef(params: {
  data: ModelsProviderData;
  parsed: DiscordModelPickerState;
  parsedProvider?: string;
  quickModels: string[];
  requireModelToken: boolean;
}): string | null {
  if (params.parsed.action === "reset") {
    return `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  }
  if (params.parsed.modelToken) {
    return resolveDiscordModelPickerModelRefByToken(params.data, params.parsed.modelToken);
  }
  if (params.parsed.action === "quick") {
    if (params.requireModelToken) {
      return null;
    }
    const slot = params.parsed.recentSlot ?? 0;
    return slot >= 1 ? (params.quickModels[slot - 1] ?? null) : null;
  }
  if (params.parsed.view === "recents") {
    if (params.requireModelToken) {
      return null;
    }
    const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
    const dedupedRecents = params.quickModels.filter((ref) => ref !== defaultModelRef);
    const slot = params.parsed.recentSlot ?? 0;
    if (slot === 1) {
      return defaultModelRef;
    }
    return slot >= 2 ? (dedupedRecents[slot - 2] ?? null) : null;
  }

  const provider = params.parsedProvider;
  const selectedModel = resolveDiscordModelPickerModelSelection({
    data: params.data,
    provider: provider ?? "",
    modelIndex: params.parsed.modelIndex,
    modelToken: params.parsed.modelToken,
    requireModelToken: params.requireModelToken,
  });
  return provider && selectedModel ? `${provider}/${selectedModel}` : null;
}

export function buildDiscordModelPickerSelectionCommand(params: {
  modelRef: string;
  runtime?: string;
}): { command: ChatCommandDefinition; args: CommandArgs; prompt: string } | null {
  const commandDefinition =
    findCommandByNativeName("model", "discord") ??
    listChatCommands().find((entry) => entry.key === "model");
  if (!commandDefinition) {
    return null;
  }
  const commandArgs: CommandArgs = {
    values: { model: params.modelRef },
    raw: params.runtime ? `${params.modelRef} --runtime ${params.runtime}` : params.modelRef,
  };
  return {
    command: commandDefinition,
    args: commandArgs,
    prompt: buildCommandTextFromArgs(commandDefinition, commandArgs),
  };
}

function resolveDiscordModelPickerRuntimeForProvider(params: {
  data: ModelsProviderData;
  provider: string;
  runtime?: string;
  allowResetRuntime?: boolean;
}): string | undefined {
  const runtime = normalizeOptionalString(params.runtime);
  if (!runtime) {
    return undefined;
  }
  if (runtime === "auto" || runtime === "default") {
    return params.allowResetRuntime ? runtime : undefined;
  }
  const matches = getDiscordModelPickerRuntimeChoices({
    data: params.data,
    provider: params.provider,
  }).filter((choice) => choice.id === runtime);
  return matches.length === 1 ? runtime : undefined;
}

/** Undefined means no runtime state; null means encoded state can no longer be resolved safely. */
export function resolveDiscordModelPickerParsedRuntime(params: {
  data: ModelsProviderData;
  provider?: string;
  parsed: DiscordModelPickerState;
}): string | null | undefined {
  const hasExactRuntimeState = Boolean(params.parsed.runtime || params.parsed.runtimeToken);
  if (!hasExactRuntimeState) {
    // A shipped position can silently select a different runtime after restart or reconfiguration.
    return params.parsed.runtimeIndex ? null : undefined;
  }
  if (!params.provider) {
    return null;
  }

  const resolved: string[] = [];
  const addResolved = (runtime: string | undefined): boolean => {
    if (!runtime) {
      return false;
    }
    resolved.push(runtime);
    return true;
  };
  if (
    params.parsed.runtime &&
    !addResolved(
      resolveDiscordModelPickerRuntimeForProvider({
        data: params.data,
        provider: params.provider,
        runtime: params.parsed.runtime,
        allowResetRuntime: true,
      }),
    )
  ) {
    return null;
  }
  if (
    params.parsed.runtimeToken &&
    !addResolved(
      resolveDiscordModelPickerRuntimeSelectionValue({
        data: params.data,
        provider: params.provider,
        raw: `r:${params.parsed.runtimeToken}`,
      }),
    )
  ) {
    return null;
  }
  const uniqueRuntimes = new Set(resolved);
  return uniqueRuntimes.size === 1 ? (resolved[0] ?? null) : null;
}

export function resolveDiscordModelPickerSubmissionRuntime(params: {
  data: ModelsProviderData;
  provider: string;
  parsedRuntime?: string;
}): string | undefined {
  return resolveDiscordModelPickerRuntimeForProvider({
    data: params.data,
    provider: params.provider,
    runtime: params.parsedRuntime,
    allowResetRuntime: true,
  });
}
