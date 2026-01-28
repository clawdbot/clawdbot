import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles.js";
import {
  type ModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { MoltbotConfig } from "../../config/config.js";
import { shortenHomePath } from "../../utils.js";
import type { ReplyPayload } from "../types.js";
import {
  formatAuthLabel,
  type ModelAuthDetailMode,
  resolveAuthLabel,
  resolveProfileOverride,
} from "./directive-handling.auth.js";
import {
  type ModelPickerCatalogEntry,
  resolveProviderEndpointLabel,
} from "./directive-handling.model-picker.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { resolveModelsCommandReply } from "./commands-models.js";
import { type ModelDirectiveSelection, resolveModelDirectiveSelection } from "./model-selection.js";

function buildModelPickerCatalog(params: {
  cfg: MoltbotConfig;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
}): ModelPickerCatalogEntry[] {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });

  const buildConfiguredCatalog = (): ModelPickerCatalogEntry[] => {
    const out: ModelPickerCatalogEntry[] = [];
    const keys = new Set<string>();

    const pushRef = (ref: { provider: string; model: string }, name?: string) => {
      const provider = normalizeProviderId(ref.provider);
      const id = String(ref.model ?? "").trim();
      if (!provider || !id) return;
      const key = modelKey(provider, id);
      if (keys.has(key)) return;
      keys.add(key);
      out.push({ provider, id, name: name ?? id });
    };

    const pushRaw = (raw?: string) => {
      const value = String(raw ?? "").trim();
      if (!value) return;
      const resolved = resolveModelRefFromString({
        raw: value,
        defaultProvider: params.defaultProvider,
        aliasIndex: params.aliasIndex,
      });
      if (!resolved) return;
      pushRef(resolved.ref);
    };

    pushRef(resolvedDefault);

    const modelConfig = params.cfg.agents?.defaults?.model;
    const modelFallbacks =
      modelConfig && typeof modelConfig === "object" ? (modelConfig.fallbacks ?? []) : [];
    for (const fallback of modelFallbacks) {
      pushRaw(String(fallback ?? ""));
    }

    const imageConfig = params.cfg.agents?.defaults?.imageModel;
    if (imageConfig && typeof imageConfig === "object") {
      pushRaw(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        pushRaw(String(fallback ?? ""));
      }
    }

    for (const raw of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
      pushRaw(raw);
    }

    return out;
  };

  const keys = new Set<string>();
  const out: ModelPickerCatalogEntry[] = [];

  const push = (entry: ModelPickerCatalogEntry) => {
    const provider = normalizeProviderId(entry.provider);
    const id = String(entry.id ?? "").trim();
    if (!provider || !id) return;
    const key = modelKey(provider, id);
    if (keys.has(key)) return;
    keys.add(key);
    out.push({ provider, id, name: entry.name });
  };

  const hasAllowlist = Object.keys(params.cfg.agents?.defaults?.models ?? {}).length > 0;
  if (!hasAllowlist) {
    for (const entry of params.allowedModelCatalog) {
      push({
        provider: entry.provider,
        id: entry.id ?? "",
        name: entry.name,
      });
    }
    for (const entry of buildConfiguredCatalog()) {
      push(entry);
    }
    return out;
  }

  // Prefer catalog entries (when available), but always merge in config-only
  // allowlist entries. This keeps custom providers/models visible in /model.
  for (const entry of params.allowedModelCatalog) {
    push({
      provider: entry.provider,
      id: entry.id ?? "",
      name: entry.name,
    });
  }

  // Merge any configured allowlist keys that the catalog doesn't know about.
  for (const raw of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
    const resolved = resolveModelRefFromString({
      raw: String(raw),
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    });
    if (!resolved) continue;
    push({
      provider: resolved.ref.provider,
      id: resolved.ref.model,
      name: resolved.ref.model,
    });
  }

  // Ensure the configured default is always present (even when no allowlist).
  if (resolvedDefault.model) {
    push({
      provider: resolvedDefault.provider,
      id: resolvedDefault.model,
      name: resolvedDefault.model,
    });
  }

  return out;
}

export async function maybeHandleModelDirectiveInfo(params: {
  directives: InlineDirectives;
  cfg: MoltbotConfig;
  agentDir: string;
  activeAgentId: string;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  resetModelOverride: boolean;
}): Promise<ReplyPayload | undefined> {
  if (!params.directives.hasModelDirective) return undefined;

  const rawDirective = params.directives.rawModelDirective?.trim();
  const directive = rawDirective?.toLowerCase();
  const wantsStatus = directive === "status";
  const wantsSummary = !rawDirective;
  const wantsLegacyList = directive === "list";
  if (!wantsSummary && !wantsStatus && !wantsLegacyList) return undefined;

  if (params.directives.rawModelProfile) {
    return { text: "Auth profile override requires a model selection." };
  }

  const pickerCatalog = buildModelPickerCatalog({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    aliasIndex: params.aliasIndex,
    allowedModelCatalog: params.allowedModelCatalog,
  });

  if (wantsLegacyList) {
    const reply = await resolveModelsCommandReply({
      cfg: params.cfg,
      commandBodyNormalized: "/models",
    });
    return reply ?? { text: "No models available." };
  }

  if (wantsSummary) {
    const current = `${params.provider}/${params.model}`;
    return {
      text: [
        `Current: ${current}`,
        "",
        "Switch: /model <provider/model>",
        "Browse: /models (providers) or /models <provider> (models)",
        "More: /model status",
      ].join("\n"),
    };
  }

  const modelsPath = `${params.agentDir}/models.json`;
  const formatPath = (value: string) => shortenHomePath(value);
  const authMode: ModelAuthDetailMode = "verbose";
  if (pickerCatalog.length === 0) return { text: "No models available." };

  const authByProvider = new Map<string, string>();
  for (const entry of pickerCatalog) {
    const provider = normalizeProviderId(entry.provider);
    if (authByProvider.has(provider)) continue;
    const auth = await resolveAuthLabel(
      provider,
      params.cfg,
      modelsPath,
      params.agentDir,
      authMode,
    );
    authByProvider.set(provider, formatAuthLabel(auth));
  }

  const current = `${params.provider}/${params.model}`;
  const defaultLabel = `${params.defaultProvider}/${params.defaultModel}`;
  const lines = [
    `Current: ${current}`,
    `Default: ${defaultLabel}`,
    `Agent: ${params.activeAgentId}`,
    `Auth file: ${formatPath(resolveAuthStorePathForDisplay(params.agentDir))}`,
  ];
  if (params.resetModelOverride) {
    lines.push(`(previous selection reset to default)`);
  }

  const byProvider = new Map<string, ModelPickerCatalogEntry[]>();
  for (const entry of pickerCatalog) {
    const provider = normalizeProviderId(entry.provider);
    const models = byProvider.get(provider);
    if (models) {
      models.push(entry);
      continue;
    }
    byProvider.set(provider, [entry]);
  }

  for (const provider of byProvider.keys()) {
    const models = byProvider.get(provider);
    if (!models) continue;
    const authLabel = authByProvider.get(provider) ?? "missing";
    const endpoint = resolveProviderEndpointLabel(provider, params.cfg);
    const endpointSuffix = endpoint.endpoint
      ? ` endpoint: ${endpoint.endpoint}`
      : " endpoint: default";
    const apiSuffix = endpoint.api ? ` api: ${endpoint.api}` : "";
    lines.push("");
    lines.push(`[${provider}]${endpointSuffix}${apiSuffix} auth: ${authLabel}`);
    for (const entry of models) {
      const label = `${provider}/${entry.id}`;
      const aliases = params.aliasIndex.byKey.get(label);
      const aliasSuffix = aliases && aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
      lines.push(`  • ${label}${aliasSuffix}`);
    }
  }
  return { text: lines.join("\n") };
}

export function resolveModelSelectionFromDirective(params: {
  directives: InlineDirectives;
  cfg: MoltbotConfig;
  agentDir: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  provider: string;
}): {
  modelSelection?: ModelDirectiveSelection;
  profileOverride?: string;
  errorText?: string;
} {
  if (!params.directives.hasModelDirective || !params.directives.rawModelDirective) {
    if (params.directives.rawModelProfile) {
      return { errorText: "Auth profile override requires a model selection." };
    }
    return {};
  }

  const raw = params.directives.rawModelDirective.trim();
  let modelSelection: ModelDirectiveSelection | undefined;

  if (/^[0-9]+$/.test(raw)) {
    return {
      errorText: [
        "Numeric model selection is not supported in chat.",
        "",
        "Browse: /models or /models <provider>",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  const explicit = resolveModelRefFromString({
    raw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (explicit) {
    const explicitKey = modelKey(explicit.ref.provider, explicit.ref.model);
    if (params.allowedModelKeys.size === 0 || params.allowedModelKeys.has(explicitKey)) {
      modelSelection = {
        provider: explicit.ref.provider,
        model: explicit.ref.model,
        isDefault:
          explicit.ref.provider === params.defaultProvider &&
          explicit.ref.model === params.defaultModel,
        ...(explicit.alias ? { alias: explicit.alias } : {}),
      };
    }
  }

  if (!modelSelection) {
    const resolved = resolveModelDirectiveSelection({
      raw,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys: params.allowedModelKeys,
    });

    if (resolved.error) {
      return { errorText: resolved.error };
    }

    if (resolved.selection) {
      modelSelection = resolved.selection;
    }
  }

  let profileOverride: string | undefined;
  if (modelSelection && params.directives.rawModelProfile) {
    const profileResolved = resolveProfileOverride({
      rawProfile: params.directives.rawModelProfile,
      provider: modelSelection.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    if (profileResolved.error) {
      return { errorText: profileResolved.error };
    }
    profileOverride = profileResolved.profileId;
  }

  return { modelSelection, profileOverride };
}
