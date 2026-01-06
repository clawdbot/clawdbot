import type { Api, Model } from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import chalk from "chalk";

import { resolveClawdbotAgentDir } from "../../agents/agent-paths.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import {
  buildModelAliasIndex,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { ensureClawdbotModelsJson } from "../../agents/models-config.js";
import {
  type ClawdbotConfig,
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
} from "../../config/config.js";
import { info } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  formatTokenK,
  modelKey,
} from "./shared.js";

const MODEL_PAD = 42;
const INPUT_PAD = 10;
const CTX_PAD = 8;
const LOCAL_PAD = 5;
const AUTH_PAD = 5;

const isRich = (opts?: { json?: boolean; plain?: boolean }) =>
  Boolean(
    process.stdout.isTTY && chalk.level > 0 && !opts?.json && !opts?.plain,
  );

const pad = (value: string, size: number) => value.padEnd(size);

const truncate = (value: string, max: number) => {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
};

type ConfiguredEntry = {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
};

type ModelRow = {
  key: string;
  name: string;
  input: string;
  contextWindow: number | null;
  local: boolean | null;
  available: boolean | null;
  tags: string[];
  missing: boolean;
};

const isLocalBaseUrl = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
};

const hasAuthForProvider = (
  provider: string,
  cfg: ClawdbotConfig,
  authStore: AuthProfileStore,
): boolean => {
  if (listProfilesForProvider(authStore, provider).length > 0) return true;
  if (resolveEnvApiKey(provider)) return true;
  if (getCustomProviderApiKey(cfg, provider)) return true;
  return false;
};

const resolveConfiguredEntries = (cfg: ClawdbotConfig) => {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const order: string[] = [];
  const tagsByKey = new Map<string, Set<string>>();
  const aliasesByKey = new Map<string, string[]>();

  for (const [key, aliases] of aliasIndex.byKey.entries()) {
    aliasesByKey.set(key, aliases);
  }

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const key = modelKey(ref.provider, ref.model);
    if (!tagsByKey.has(key)) {
      tagsByKey.set(key, new Set());
      order.push(key);
    }
    tagsByKey.get(key)?.add(tag);
  };

  addEntry(resolvedDefault, "default");

  const modelConfig = cfg.agent?.model as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  const imageModelConfig = cfg.agent?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  const modelFallbacks =
    typeof modelConfig === "object" ? (modelConfig?.fallbacks ?? []) : [];
  const imageFallbacks =
    typeof imageModelConfig === "object"
      ? (imageModelConfig?.fallbacks ?? [])
      : [];
  const imagePrimary = imageModelConfig?.primary?.trim() ?? "";

  modelFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolved) return;
    addEntry(resolved.ref, `fallback#${idx + 1}`);
  });

  if (imagePrimary) {
    const resolved = resolveModelRefFromString({
      raw: imagePrimary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (resolved) addEntry(resolved.ref, "image");
  }

  imageFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolved) return;
    addEntry(resolved.ref, `img-fallback#${idx + 1}`);
  });

  for (const key of Object.keys(cfg.agent?.models ?? {})) {
    const parsed = parseModelRef(String(key ?? ""), DEFAULT_PROVIDER);
    if (!parsed) continue;
    addEntry(parsed, "configured");
  }

  const entries: ConfiguredEntry[] = order.map((key) => {
    const slash = key.indexOf("/");
    const provider = slash === -1 ? key : key.slice(0, slash);
    const model = slash === -1 ? "" : key.slice(slash + 1);
    return {
      key,
      ref: { provider, model },
      tags: tagsByKey.get(key) ?? new Set(),
      aliases: aliasesByKey.get(key) ?? [],
    } satisfies ConfiguredEntry;
  });

  return { entries };
};

async function loadModelRegistry(cfg: ClawdbotConfig) {
  await ensureClawdbotModelsJson(cfg);
  const agentDir = resolveClawdbotAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  const registry = discoverModels(authStorage, agentDir);
  const models = registry.getAll() as Model<Api>[];
  const availableModels = registry.getAvailable() as Model<Api>[];
  const availableKeys = new Set(
    availableModels.map((model) => modelKey(model.provider, model.id)),
  );
  return { registry, models, availableKeys };
}

function toModelRow(params: {
  model?: Model<Api>;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  cfg?: ClawdbotConfig;
  authStore?: AuthProfileStore;
}): ModelRow {
  const {
    model,
    key,
    tags,
    aliases = [],
    availableKeys,
    cfg,
    authStore,
  } = params;
  if (!model) {
    return {
      key,
      name: key,
      input: "-",
      contextWindow: null,
      local: null,
      available: null,
      tags: [...tags, "missing"],
      missing: true,
    };
  }

  const input = model.input.join("+") || "text";
  const local = isLocalBaseUrl(model.baseUrl);
  const available =
    availableKeys?.has(modelKey(model.provider, model.id)) ||
    (cfg && authStore
      ? hasAuthForProvider(model.provider, cfg, authStore)
      : false);
  const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
  const mergedTags = new Set(tags);
  if (aliasTags.length > 0) {
    for (const tag of mergedTags) {
      if (tag === "alias" || tag.startsWith("alias:")) mergedTags.delete(tag);
    }
    for (const tag of aliasTags) mergedTags.add(tag);
  }

  return {
    key,
    name: model.name || model.id,
    input,
    contextWindow: model.contextWindow ?? null,
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
  };
}

function printModelTable(
  rows: ModelRow[],
  runtime: RuntimeEnv,
  opts: { json?: boolean; plain?: boolean } = {},
) {
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: rows.length,
          models: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.plain) {
    for (const row of rows) runtime.log(row.key);
    return;
  }

  const rich = isRich(opts);
  const header = [
    pad("Model", MODEL_PAD),
    pad("Input", INPUT_PAD),
    pad("Ctx", CTX_PAD),
    pad("Local", LOCAL_PAD),
    pad("Auth", AUTH_PAD),
    "Tags",
  ].join(" ");
  runtime.log(rich ? chalk.bold(header) : header);

  for (const row of rows) {
    const keyLabel = pad(truncate(row.key, MODEL_PAD), MODEL_PAD);
    const inputLabel = pad(row.input || "-", INPUT_PAD);
    const ctxLabel = pad(formatTokenK(row.contextWindow), CTX_PAD);
    const localLabel = pad(
      row.local === null ? "-" : row.local ? "yes" : "no",
      LOCAL_PAD,
    );
    const authLabel = pad(
      row.available === null ? "-" : row.available ? "yes" : "no",
      AUTH_PAD,
    );
    const tagsLabel = row.tags.length > 0 ? row.tags.join(",") : "";

    const line = [
      rich ? chalk.cyan(keyLabel) : keyLabel,
      inputLabel,
      ctxLabel,
      localLabel,
      authLabel,
      rich ? chalk.gray(tagsLabel) : tagsLabel,
    ].join(" ");
    runtime.log(line);
  }
}

export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const authStore = ensureAuthProfileStore();
  const providerFilter = opts.provider?.trim().toLowerCase();

  let models: Model<Api>[] = [];
  let availableKeys: Set<string> | undefined;
  try {
    const loaded = await loadModelRegistry(cfg);
    models = loaded.models;
    availableKeys = loaded.availableKeys;
  } catch (err) {
    runtime.error(`Model registry unavailable: ${String(err)}`);
  }

  const modelByKey = new Map(
    models.map((model) => [modelKey(model.provider, model.id), model]),
  );

  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));

  const rows: ModelRow[] = [];

  if (opts.all) {
    const sorted = [...models].sort((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) return p;
      return a.id.localeCompare(b.id);
    });

    for (const model of sorted) {
      if (providerFilter && model.provider.toLowerCase() !== providerFilter) {
        continue;
      }
      if (opts.local && !isLocalBaseUrl(model.baseUrl)) continue;
      const key = modelKey(model.provider, model.id);
      const configured = configuredByKey.get(key);
      rows.push(
        toModelRow({
          model,
          key,
          tags: configured ? Array.from(configured.tags) : [],
          aliases: configured?.aliases ?? [],
          availableKeys,
          cfg,
          authStore,
        }),
      );
    }
  } else {
    for (const entry of entries) {
      if (
        providerFilter &&
        entry.ref.provider.toLowerCase() !== providerFilter
      ) {
        continue;
      }
      const model = modelByKey.get(entry.key);
      if (opts.local && model && !isLocalBaseUrl(model.baseUrl)) continue;
      if (opts.local && !model) continue;
      rows.push(
        toModelRow({
          model,
          key: entry.key,
          tags: Array.from(entry.tags),
          aliases: entry.aliases,
          availableKeys,
          cfg,
          authStore,
        }),
      );
    }
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}

export async function modelsStatusCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  const modelConfig = cfg.agent?.model as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const imageConfig = cfg.agent?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const rawModel =
    typeof modelConfig === "string"
      ? modelConfig.trim()
      : (modelConfig?.primary?.trim() ?? "");
  const defaultLabel = rawModel || `${resolved.provider}/${resolved.model}`;
  const fallbacks =
    typeof modelConfig === "object" ? (modelConfig?.fallbacks ?? []) : [];
  const imageModel =
    typeof imageConfig === "string"
      ? imageConfig.trim()
      : (imageConfig?.primary?.trim() ?? "");
  const imageFallbacks =
    typeof imageConfig === "object" ? (imageConfig?.fallbacks ?? []) : [];
  const aliases = Object.entries(cfg.agent?.models ?? {}).reduce<
    Record<string, string>
  >((acc, [key, entry]) => {
    const alias = entry?.alias?.trim();
    if (alias) acc[alias] = key;
    return acc;
  }, {});
  const allowed = Object.keys(cfg.agent?.models ?? {});

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          configPath: CONFIG_PATH_CLAWDBOT,
          defaultModel: defaultLabel,
          resolvedDefault: `${resolved.provider}/${resolved.model}`,
          fallbacks,
          imageModel: imageModel || null,
          imageFallbacks,
          aliases,
          allowed,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.plain) {
    runtime.log(defaultLabel);
    return;
  }

  runtime.log(info(`Config: ${CONFIG_PATH_CLAWDBOT}`));
  runtime.log(`Default: ${defaultLabel}`);
  runtime.log(
    `Fallbacks (${fallbacks.length || 0}): ${fallbacks.join(", ") || "-"}`,
  );
  runtime.log(`Image model: ${imageModel || "-"}`);
  runtime.log(
    `Image fallbacks (${imageFallbacks.length || 0}): ${
      imageFallbacks.length ? imageFallbacks.join(", ") : "-"
    }`,
  );
  runtime.log(
    `Aliases (${Object.keys(aliases).length || 0}): ${
      Object.keys(aliases).length
        ? Object.entries(aliases)
            .map(([alias, target]) => `${alias} -> ${target}`)
            .join(", ")
        : "-"
    }`,
  );
  runtime.log(
    `Configured models (${allowed.length || 0}): ${
      allowed.length ? allowed.join(", ") : "all"
    }`,
  );
}
