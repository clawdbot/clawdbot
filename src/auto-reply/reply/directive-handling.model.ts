import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/selection.js";
import {
  type ModelAliasIndex,
  buildConfiguredModelCatalog,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { buildAgentRuntimeAuthPlan } from "../../agents/runtime-plan/auth.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { shortenHomePath } from "../../utils.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import type { ReplyPayload } from "../types.js";
import { resolveModelsCommandReply } from "./commands-models.js";
import {
  formatAuthLabel,
  type ModelAuthDetailMode,
  resolveAuthLabel,
} from "./directive-handling.auth.js";
import {
  type ModelPickerCatalogEntry,
  resolveProviderEndpointLabel,
} from "./directive-handling.model-picker.js";
export { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

function isMissingAuthLabel(auth: { label: string; source: string }): boolean {
  return auth.label === "missing" && auth.source === "missing";
}

function resolveStatusHarnessRuntime(params: {
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
  defaultRuntime: string;
}): string {
  void params.sessionEntry;
  return params.defaultRuntime;
}

async function resolveStatusAuthLabel(params: {
  provider: string;
  modelId: string;
  cfg: OpenClawConfig;
  modelsPath: string;
  agentDir: string;
  activeAgentId: string;
  authMode: ModelAuthDetailMode;
  workspaceDir?: string;
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
}): Promise<string> {
  const auth = await resolveAuthLabel(
    params.provider,
    params.cfg,
    params.modelsPath,
    params.agentDir,
    params.authMode,
    params.workspaceDir,
  );
  if (!isMissingAuthLabel(auth)) {
    return formatAuthLabel(auth);
  }

  const provider = normalizeProviderId(params.provider);
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider,
    modelId: params.modelId,
    config: params.cfg,
    agentId: params.activeAgentId,
  });
  const harnessRuntime = resolveStatusHarnessRuntime({
    sessionEntry: params.sessionEntry,
    defaultRuntime: harnessPolicy.runtime,
  });
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    harnessRuntime,
  });
  const effectiveAuthProvider = runtimeAuthPlan.harnessAuthProvider;
  if (!effectiveAuthProvider || effectiveAuthProvider === provider) {
    return formatAuthLabel(auth);
  }

  const runtimeAuth = await resolveAuthLabel(
    effectiveAuthProvider,
    params.cfg,
    params.modelsPath,
    params.agentDir,
    params.authMode,
    params.workspaceDir,
  );
  if (isMissingAuthLabel(runtimeAuth)) {
    return formatAuthLabel(auth);
  }
  return `via ${harnessRuntime} runtime / ${effectiveAuthProvider} ${formatAuthLabel(runtimeAuth)}`;
}

function pushUniqueCatalogEntry(params: {
  keys: Set<string>;
  out: ModelPickerCatalogEntry[];
  provider: string;
  id: string;
  name?: string;
  fallbackNameToId: boolean;
}) {
  const provider = normalizeProviderId(params.provider);
  const id = normalizeOptionalString(params.id) ?? "";
  if (!provider || !id) {
    return;
  }
  const key = modelKey(provider, id);
  if (params.keys.has(key)) {
    return;
  }
  params.keys.add(key);
  params.out.push({
    provider,
    id,
    name: params.fallbackNameToId ? (params.name ?? id) : params.name,
  });
}

function buildModelPickerCatalog(params: {
  cfg: OpenClawConfig;
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
      pushUniqueCatalogEntry({
        keys,
        out,
        provider: ref.provider,
        id: ref.model,
        name,
        fallbackNameToId: true,
      });
    };

    const pushRaw = (raw?: string) => {
      const value = normalizeOptionalString(raw) ?? "";
      if (!value) {
        return;
      }
      const resolved = resolveModelRefFromString({
        raw: value,
        defaultProvider: params.defaultProvider,
        aliasIndex: params.aliasIndex,
      });
      if (!resolved) {
        return;
      }
      pushRef(resolved.ref);
    };

    pushRef(resolvedDefault);

    const modelConfig = params.cfg.agents?.defaults?.model;
    const modelFallbacks =
      modelConfig && typeof modelConfig === "object" ? (modelConfig.fallbacks ?? []) : [];
    for (const fallback of modelFallbacks) {
      pushRaw(fallback ?? "");
    }

    const imageConfig = params.cfg.agents?.defaults?.imageModel;
    if (imageConfig && typeof imageConfig === "object") {
      pushRaw(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        pushRaw(fallback ?? "");
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
    pushUniqueCatalogEntry({
      keys,
      out,
      provider: entry.provider,
      id: entry.id ?? "",
      name: entry.name,
      fallbackNameToId: false,
    });
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
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    });
    if (!resolved) {
      continue;
    }
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

function filterMissingAuthNestedProviderDuplicates(params: {
  cfg: OpenClawConfig;
  entries: ModelPickerCatalogEntry[];
  authByProvider: Map<string, string>;
}): ModelPickerCatalogEntry[] {
  const configuredKeys = new Set(
    buildConfiguredModelCatalog({ cfg: params.cfg }).map((entry) =>
      modelKey(entry.provider, entry.id),
    ),
  );
  const wrapperKeys = new Set<string>();
  for (const entry of params.entries) {
    const id = normalizeOptionalString(entry.id) ?? "";
    const slash = id.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const nestedProvider = normalizeProviderId(id.slice(0, slash));
    const nestedModel = normalizeOptionalString(id.slice(slash + 1)) ?? "";
    const wrapperProvider = normalizeProviderId(entry.provider);
    if (!nestedProvider || !nestedModel || nestedProvider === wrapperProvider) {
      continue;
    }
    wrapperKeys.add(modelKey(nestedProvider, nestedModel));
  }
  if (wrapperKeys.size === 0) {
    return params.entries;
  }

  return params.entries.filter((entry) => {
    const provider = normalizeProviderId(entry.provider);
    const id = normalizeOptionalString(entry.id) ?? "";
    const key = modelKey(provider, id);
    if (configuredKeys.has(key)) {
      return true;
    }
    return params.authByProvider.get(provider) !== "missing" || !wrapperKeys.has(key);
  });
}

export async function maybeHandleModelDirectiveInfo(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  activeAgentId: string;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  resetModelOverride: boolean;
  workspaceDir?: string;
  surface?: string;
  sessionEntry?: Pick<SessionEntry, "modelProvider" | "model"> &
    Partial<Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">>;
}): Promise<ReplyPayload | undefined> {
  if (!params.directives.hasModelDirective) {
    return undefined;
  }

  const rawDirective = normalizeOptionalString(params.directives.rawModelDirective);
  const directive = rawDirective ? normalizeLowercaseStringOrEmpty(rawDirective) : undefined;
  const wantsStatus = directive === "status";
  const wantsSummary = !rawDirective;
  const wantsLegacyList = directive === "list";
  if (!wantsSummary && !wantsStatus && !wantsLegacyList) {
    return undefined;
  }

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
      surface: params.surface,
      currentModel: `${params.provider}/${params.model}`,
      agentId: params.activeAgentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      sessionEntry: isCompleteSessionEntry(params.sessionEntry) ? params.sessionEntry : undefined,
    });
    return reply ?? { text: "No models available." };
  }

  if (wantsSummary) {
    const modelRefs = resolveSelectedAndActiveModel({
      selectedProvider: params.provider,
      selectedModel: params.model,
      sessionEntry: params.sessionEntry,
    });
    const current = modelRefs.selected.label;
    const activeRuntimeLine = modelRefs.activeDiffers
      ? `Active: ${modelRefs.active.label} (runtime)`
      : null;
    const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
    const channelData = commandPlugin?.commands?.buildModelBrowseChannelData?.();
    if (channelData) {
      return {
        text: [
          `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
          activeRuntimeLine,
          "",
          "Tap below to browse models, or use:",
          "/model <provider/model> to switch",
          "/model <provider/model> --runtime <runtime> to switch harnesses",
          "/model status for details",
        ]
          .filter(Boolean)
          .join("\n"),
        channelData,
      };
    }

    return {
      text: [
        `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
        activeRuntimeLine,
        "",
        "Switch: /model <provider/model>",
        "Runtime: /model <provider/model> --runtime <runtime>",
        "Browse: /models (providers) or /models <provider> (models)",
        "More: /model status",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const modelsPath = `${params.agentDir}/models.json`;
  const formatPath = (value: string) => shortenHomePath(value);
  const authMode: ModelAuthDetailMode = "verbose";
  if (pickerCatalog.length === 0) {
    return { text: "No models available." };
  }

  const authByProvider = new Map<string, string>();
  for (const entry of pickerCatalog) {
    const provider = normalizeProviderId(entry.provider);
    if (authByProvider.has(provider)) {
      continue;
    }
    const authLabel = await resolveStatusAuthLabel({
      provider,
      modelId: entry.id,
      cfg: params.cfg,
      modelsPath,
      agentDir: params.agentDir,
      activeAgentId: params.activeAgentId,
      authMode,
      workspaceDir: params.workspaceDir,
      sessionEntry: params.sessionEntry,
    });
    authByProvider.set(provider, authLabel);
  }

  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider: params.provider,
    selectedModel: params.model,
    sessionEntry: params.sessionEntry,
  });
  const current = modelRefs.selected.label;
  const defaultLabel = `${params.defaultProvider}/${params.defaultModel}`;
  const lines = [
    `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
    modelRefs.activeDiffers ? `Active: ${modelRefs.active.label} (runtime)` : null,
    `Default: ${defaultLabel}`,
    `Agent: ${params.activeAgentId}`,
    `Auth file: ${formatPath(resolveAuthStorePathForDisplay(params.agentDir))}`,
  ].filter((line): line is string => Boolean(line));
  if (params.resetModelOverride) {
    lines.push(`(previous selection reset to default)`);
  }

  const byProvider = new Map<string, ModelPickerCatalogEntry[]>();
  const statusCatalog = filterMissingAuthNestedProviderDuplicates({
    cfg: params.cfg,
    entries: pickerCatalog,
    authByProvider,
  });
  for (const entry of statusCatalog) {
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
    if (!models) {
      continue;
    }
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

function isCompleteSessionEntry(
  entry: Pick<SessionEntry, "modelProvider" | "model"> | undefined,
): entry is SessionEntry {
  return Boolean(
    entry &&
    typeof (entry as Partial<SessionEntry>).sessionId === "string" &&
    typeof (entry as Partial<SessionEntry>).updatedAt === "number",
  );
}
