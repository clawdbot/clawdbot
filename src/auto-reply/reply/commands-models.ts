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
import { resolveConfigWriteTargetFromPath } from "../../channels/plugins/config-writes.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeChannelId } from "../../channels/registry.js";
import { isModelsWriteEnabled } from "../../config/commands.flags.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";
import { resolveChannelAccountId } from "./channel-context.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";
import { addModelToConfig, listAddableProviders, validateAddProvider } from "./models-add.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

type ModelsCommandSessionEntry = Partial<
  Pick<SessionEntry, "authProfileOverride" | "modelProvider" | "model">
>;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  modelNames: Map<string, string>;
};

type ParsedModelsCommand =
  | { action: "providers" }
  | {
      action: "list";
      provider?: string;
      page: number;
      pageSize: number;
      all: boolean;
    }
  | {
      action: "add";
      provider?: string;
      modelId?: string;
    };

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

  for (const raw of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    addRawModelRef(raw);
  }

  add(resolvedDefault.provider, resolvedDefault.model);
  addModelConfigEntries();

  const providers = [...byProvider.keys()].toSorted();

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

function parseListArgs(tokens: string[]): Extract<ParsedModelsCommand, { action: "list" }> {
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
    action: "list",
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

function parseModelsArgs(raw: string): ParsedModelsCommand {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { action: "providers" };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  switch (first) {
    case "providers":
      return { action: "providers" };
    case "list":
      return parseListArgs(tokens.slice(1));
    case "add":
      return {
        action: "add",
        provider: normalizeOptionalString(tokens[1]),
        modelId: normalizeOptionalString(tokens.slice(2).join(" ")),
      };
    default:
      return parseListArgs(tokens);
  }
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

function buildModelsMenuText(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  includeAddAction?: boolean;
}): string {
  return [
    "Providers:",
    ...params.providers.map((provider) =>
      formatProviderLine({
        provider,
        count: params.byProvider.get(provider)?.size ?? 0,
      }),
    ),
    "",
    "Use: /models <provider>",
    "Switch: /model <provider/model>",
    ...(params.includeAddAction ? ["Add: /models add"] : []),
  ].join("\n");
}

function formatCopyableCommand(command: string): string {
  return ["```text", command, "```"].join("\n");
}

function buildAddExamples(addableProviders: readonly string[]): string[] {
  const examples: string[] = [];
  if (addableProviders.includes("ollama")) {
    examples.push("/models add ollama glm-5.1:cloud");
  }
  if (addableProviders.includes("lmstudio")) {
    examples.push("/models add lmstudio qwen/qwen3.5-9b");
  }
  if (addableProviders.includes("codex")) {
    examples.push("/models add codex gpt-5.4-mini");
  }
  if (addableProviders.includes("openai-codex")) {
    examples.push("/models add openai-codex gpt-5.4");
  }
  if (examples.length === 0) {
    examples.push("/models add <provider> <modelId>");
  }
  return examples.slice(0, 3);
}

function resolveWriteProvider(params: {
  cfg: OpenClawConfig;
  parsed: ParsedModelsCommand;
}): string | undefined {
  if (params.parsed.action !== "add") {
    return undefined;
  }
  return params.parsed.provider ? normalizeProviderId(params.parsed.provider) : undefined;
}

function buildProviderInfos(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): Array<{ id: string; count: number }> {
  return params.providers.map((provider) => ({
    id: provider,
    count: params.byProvider.get(provider)?.size ?? 0,
  }));
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
  const parsed = parseModelsArgs(argText);

  const { byProvider, providers, modelNames } = await buildModelsProviderData(
    params.cfg,
    params.agentId,
  );
  const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
  const providerInfos = buildProviderInfos({ providers, byProvider });
  const modelsWriteEnabled = isModelsWriteEnabled(params.cfg);

  if (parsed.action === "providers") {
    const channelData =
      (modelsWriteEnabled
        ? commandPlugin?.commands?.buildModelsMenuChannelData?.({
            providers: providerInfos,
          })
        : null) ??
      commandPlugin?.commands?.buildModelsProviderChannelData?.({
        providers: providerInfos,
      });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider, includeAddAction: modelsWriteEnabled }),
    };
  }

  if (parsed.action === "add") {
    if (!modelsWriteEnabled) {
      return {
        text: "⚠️ /models add is disabled. Set commands.modelsWrite=true to enable model registration.",
      };
    }
    const addableProviders = listAddableProviders({
      cfg: params.cfg,
      discoveredProviders: providers,
    });
    if (!parsed.provider) {
      const channelData = commandPlugin?.commands?.buildModelsAddProviderChannelData?.({
        providers: addableProviders.map((id) => ({ id })),
      });
      return {
        text: [
          "Add a model: choose a provider, then send one of these example commands.",
          "",
          "These examples use models that already exist for those providers.",
          "",
          ...buildAddExamples(addableProviders).flatMap((example) => [
            formatCopyableCommand(example),
            "",
          ]),
          "Generic form:",
          formatCopyableCommand("/models add <provider> <modelId>"),
          "",
          "Providers:",
          ...addableProviders.map((provider) => `- ${provider}`),
        ].join("\n"),
        ...(channelData ? { channelData } : {}),
      };
    }

    const validatedProvider = validateAddProvider({
      cfg: params.cfg,
      provider: parsed.provider,
      discoveredProviders: providers,
    });
    if (!validatedProvider.ok) {
      return {
        text: [
          `Unknown provider: ${parsed.provider}`,
          "",
          "Available providers:",
          ...validatedProvider.providers.map((provider) => `- ${provider}`),
          "",
          "Use:",
          "/models add <provider> <modelId>",
        ].join("\n"),
      };
    }

    if (!parsed.modelId) {
      return {
        text: [
          `Add a model to ${validatedProvider.provider}:`,
          "",
          "Use:",
          formatCopyableCommand(`/models add ${validatedProvider.provider} <modelId>`),
          "",
          "Browse current models:",
          formatCopyableCommand(`/models ${validatedProvider.provider}`),
        ].join("\n"),
      };
    }

    const added = await addModelToConfig({
      cfg: params.cfg,
      provider: validatedProvider.provider,
      modelId: parsed.modelId,
    });
    if (!added.ok) {
      return {
        text: `⚠️ ${added.error}`,
      };
    }

    const modelRef = `${added.result.provider}/${added.result.modelId}`;
    const warnings =
      added.result.warnings.length > 0
        ? ["", ...added.result.warnings.map((warning) => `- ${warning}`)]
        : [];
    const allowlistNote = added.result.allowlistAdded ? " and added to the allowlist" : "";
    return {
      text: [
        added.result.existed
          ? `✅ Model already exists: ${modelRef}${allowlistNote}.`
          : `✅ Added model: ${modelRef}${allowlistNote}.`,
        "Browse:",
        `/models ${added.result.provider}`,
        "",
        "Switch now:",
        `/model ${modelRef}`,
        ...warnings,
      ].join("\n"),
    };
  }

  const { provider, page, pageSize, all } = parsed;

  if (!provider) {
    const channelData = commandPlugin?.commands?.buildModelsProviderChannelData?.({
      providers: providerInfos,
    });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider, includeAddAction: modelsWriteEnabled }),
    };
  }

  if (!byProvider.has(provider)) {
    return {
      text: [
        `Unknown provider: ${provider}`,
        "",
        "Available providers:",
        ...providers.map((entry) => `- ${entry}`),
        "",
        "Use: /models <provider>",
      ].join("\n"),
    };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;

  if (total === 0) {
    const emptyProviderLabel = resolveProviderLabel({
      provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
      sessionEntry: params.sessionEntry,
    });
    return {
      text: [
        `Models (${emptyProviderLabel}) — none`,
        "",
        "Browse: /models",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
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
    return {
      text: formatModelsAvailableHeader({
        provider,
        total,
        cfg: params.cfg,
        agentDir: params.agentDir,
        sessionEntry: params.sessionEntry,
      }),
      channelData: interactiveChannelData,
    };
  }

  const effectivePageSize = all ? total : pageSize;
  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
  const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));

  if (!all && page !== safePage) {
    return {
      text: [
        `Page out of range: ${page} (valid: 1-${pageCount})`,
        "",
        `Try: /models list ${provider} ${safePage}`,
        `All: /models list ${provider} all`,
      ].join("\n"),
    };
  }

  const startIndex = (safePage - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);
  const providerLabel = resolveProviderLabel({
    provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
  });
  const lines = [
    `Models (${providerLabel}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`,
  ];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }
  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models list ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models list ${provider} all`);
  }
  return { text: lines.join("\n") };
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBodyNormalized = params.command.commandBodyNormalized.trim();
  if (!commandBodyNormalized.startsWith("/models")) {
    return null;
  }
  const parsed = parseModelsArgs(commandBodyNormalized.replace(/^\/models\b/i, "").trim());
  const unauthorized = rejectUnauthorizedCommand(params, "/models");
  if (unauthorized) {
    return unauthorized;
  }

  if (parsed.action === "add") {
    if (!isModelsWriteEnabled(params.cfg)) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ /models add is disabled. Set commands.modelsWrite=true to enable model registration.",
        },
      };
    }
    const commandLabel = "/models add";
    const nonOwner = rejectNonOwnerCommand(params, commandLabel);
    if (nonOwner) {
      return nonOwner;
    }
    const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
      label: commandLabel,
      allowedScopes: ["operator.admin"],
      missingText: "❌ /models add requires operator.admin for gateway clients.",
    });
    if (missingAdminScope) {
      return missingAdminScope;
    }
    const writeProvider = resolveWriteProvider({
      cfg: params.cfg,
      parsed,
    });
    if (writeProvider) {
      const channelId = params.command.channelId ?? normalizeChannelId(params.command.channel);
      const accountId = resolveChannelAccountId({
        cfg: params.cfg,
        ctx: params.ctx,
        command: params.command,
      });
      for (const path of [
        ["models", "providers", writeProvider],
        ["models", "providers", writeProvider, "models"],
        ["agents", "defaults", "models"],
      ]) {
        const deniedText = resolveConfigWriteDeniedText({
          cfg: params.cfg,
          channel: params.command.channel,
          channelId,
          accountId,
          gatewayClientScopes: params.ctx.GatewayClientScopes,
          target: resolveConfigWriteTargetFromPath(path),
        });
        if (deniedText) {
          return {
            shouldContinue: false,
            reply: { text: deniedText },
          };
        }
      }
    }
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
