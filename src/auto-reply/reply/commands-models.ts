import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
type ModelsCommandSessionEntry = Partial<
  Pick<SessionEntry, "authProfileOverride" | "modelProvider" | "model">
>;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  /** Map from provider/model to human-readable display name (when different from model ID). */
  modelNames: Map<string, string>;
};

/**
 * Build provider/model data from config and catalog.
 * Exported for reuse by callback handlers.
 */
export async function buildModelsProviderData(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<ModelsProviderData> {
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg,
    agentId,
  });

  const catalog = await loadModelCatalog({ config: cfg });
  const allowed = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
    agentId,
  });

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolvedDefault.provider,
  });

  const byProvider = new Map<string, Set<string>>();
  const add = (p: string, m: string) => {
    const key = normalizeProviderId(p);
    const set = byProvider.get(key) ?? new Set<string>();
    set.add(m);
    byProvider.set(key, set);
  };

  const addRawModelRef = (raw?: string) => {
    const trimmed = normalizeOptionalString(raw);
    if (!trimmed) {
      return;
    }
    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: resolvedDefault.provider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    add(resolved.ref.provider, resolved.ref.model);
  };

  const addModelConfigEntries = () => {
    const modelConfig = cfg.agents?.defaults?.model;
    if (typeof modelConfig === "string") {
      addRawModelRef(modelConfig);
    } else if (modelConfig && typeof modelConfig === "object") {
      addRawModelRef(modelConfig.primary);
      for (const fallback of modelConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }

    const imageConfig = cfg.agents?.defaults?.imageModel;
    if (typeof imageConfig === "string") {
      addRawModelRef(imageConfig);
    } else if (imageConfig && typeof imageConfig === "object") {
      addRawModelRef(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        addRawModelRef(fallback);
      }
    }
  };

  for (const entry of allowed.allowedCatalog) {
    add(entry.provider, entry.id);
  }

  // Include config-only allowlist keys that aren't in the curated catalog.
  for (const raw of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    addRawModelRef(raw);
  }

  // Ensure configured defaults/fallbacks/image models show up even when the
  // curated catalog doesn't know about them (custom providers, dev builds, etc.).
  add(resolvedDefault.provider, resolvedDefault.model);
  addModelConfigEntries();

  const providers = [...byProvider.keys()].toSorted();

  // Build a provider-scoped model display-name map so surfaces can show
  // human-readable names without colliding across providers that share IDs.
  const modelNames = new Map<string, string>();
  for (const entry of catalog) {
    if (entry.name && entry.name !== entry.id) {
      modelNames.set(`${normalizeProviderId(entry.provider)}/${entry.id}`, entry.name);
    }
  }

  return { byProvider, providers, resolvedDefault, modelNames };
}

function formatProviderLine(params: { provider: string; count: number }): string {
  return `- ${params.provider} (${params.count})`;
}

function parseModelsArgs(raw: string): {
  provider?: string;
  page: number;
  pageSize: number;
  all: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { page: 1, pageSize: PAGE_SIZE_DEFAULT, all: false };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const provider = normalizeOptionalString(tokens[0]);

  let page = 1;
  let all = false;
  for (const token of tokens.slice(1)) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    if (lower.startsWith("page=")) {
      const value = Number.parseInt(lower.slice("page=".length), 10);
      if (Number.isFinite(value) && value > 0) {
        page = value;
      }
      continue;
    }
    if (/^[0-9]+$/.test(lower)) {
      const value = Number.parseInt(lower, 10);
      if (Number.isFinite(value) && value > 0) {
        page = value;
      }
    }
  }

  let pageSize = PAGE_SIZE_DEFAULT;
  for (const token of tokens) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower.startsWith("limit=") || lower.startsWith("size=")) {
      const rawValue = lower.slice(lower.indexOf("=") + 1);
      const value = Number.parseInt(rawValue, 10);
      if (Number.isFinite(value) && value > 0) {
        pageSize = Math.min(PAGE_SIZE_MAX, value);
      }
    }
  }

  return {
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

function resolveProviderLabel(params: {
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string {
  const authLabel = resolveModelAuthLabel({
    provider: params.provider,
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    agentDir: params.agentDir,
  });
  if (!authLabel || authLabel === "unknown") {
    return params.provider;
  }
  return `${params.provider} · 🔑 ${authLabel}`;
}

export function formatModelsAvailableHeader(params: {
  provider: string;
  total: number;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string {
  const providerLabel = resolveProviderLabel({
    provider: params.provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
  });
  return `Models (${providerLabel}) — ${params.total} available`;
}

export async function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) {
    return null;
  }

  const argText = body.replace(/^\/models\b/i, "").trim();
  const { provider, page, pageSize, all } = parseModelsArgs(argText);

  const { byProvider, providers, modelNames } = await buildModelsProviderData(
    params.cfg,
    params.agentId,
  );
  const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;

  // Provider list (no provider specified)
  if (!provider) {
    const providerInfos = providers.map((p) => ({
      id: p,
      count: byProvider.get(p)?.size ?? 0,
    }));
    const channelData = commandPlugin?.commands?.buildModelsProviderChannelData?.({
      providers: providerInfos,
    });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }

    const lines: string[] = [
      "Providers:",
      ...providers.map((p) =>
        formatProviderLine({ provider: p, count: byProvider.get(p)?.size ?? 0 }),
      ),
      "",
      "Use: /models <provider>",
      "Switch: /model <provider/model>",
    ];
    return { text: lines.join("\n") };
  }

  if (!byProvider.has(provider)) {
    const lines: string[] = [
      `Unknown provider: ${provider}`,
      "",
      "Available providers:",
      ...providers.map((p) => `- ${p}`),
      "",
      "Use: /models <provider>",
    ];
    return { text: lines.join("\n") };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;
  const providerLabel = resolveProviderLabel({
    provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
  });

  if (total === 0) {
    const lines: string[] = [
      `Models (${providerLabel}) — none`,
      "",
      "Browse: /models",
      "Switch: /model <provider/model>",
    ];
    return { text: lines.join("\n") };
  }

  const interactivePageSize = 8;
  const interactiveTotalPages = Math.max(1, Math.ceil(total / interactivePageSize));
  const interactivePage = Math.max(1, Math.min(page, interactiveTotalPages));
  const interactiveChannelData = commandPlugin?.commands?.buildModelsListChannelData?.({
    provider,
    models,
    currentModel: params.currentModel,
    currentPage: interactivePage,
    totalPages: interactiveTotalPages,
    pageSize: interactivePageSize,
    modelNames,
  });
  if (interactiveChannelData) {
    const text = formatModelsAvailableHeader({
      provider,
      total,
      cfg: params.cfg,
      agentDir: params.agentDir,
      sessionEntry: params.sessionEntry,
    });
    return {
      text,
      channelData: interactiveChannelData,
    };
  }

  const effectivePageSize = all ? total : pageSize;
  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
  const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));

  if (!all && page !== safePage) {
    const lines: string[] = [
      `Page out of range: ${page} (valid: 1-${pageCount})`,
      "",
      `Try: /models ${provider} ${safePage}`,
      `All: /models ${provider} all`,
    ];
    return { text: lines.join("\n") };
  }

  const startIndex = (safePage - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);

  const header = `Models (${providerLabel}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`;

  const lines: string[] = [header];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }

  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models ${provider} all`);
  }

  const payload: ReplyPayload = { text: lines.join("\n") };
  return payload;
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBodyNormalized = params.command.commandBodyNormalized.trim();
  if (!commandBodyNormalized.startsWith("/models")) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/models");
  if (unauthorized) {
    return unauthorized;
  }

  const modelsAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: params.cfg,
      })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const modelsAgentDir =
    modelsAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, modelsAgentId);
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  const reply = await resolveModelsCommandReply({
    cfg: params.cfg,
    commandBodyNormalized,
    surface: params.ctx.Surface,
    currentModel: params.model ? `${params.provider}/${params.model}` : undefined,
    agentId: modelsAgentId,
    agentDir: modelsAgentDir,
    sessionEntry: targetSessionEntry,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
