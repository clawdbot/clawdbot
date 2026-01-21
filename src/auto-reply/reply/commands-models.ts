import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  normalizeProviderId,
  resolveConfiguredModelRef,
} from "../../agents/model-selection.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

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
  const provider = tokens[0]?.trim();

  let page = 1;
  let all = false;
  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    if (lower.startsWith("page=")) {
      const value = Number.parseInt(lower.slice("page=".length), 10);
      if (Number.isFinite(value) && value > 0) page = value;
      continue;
    }
    if (/^[0-9]+$/.test(lower)) {
      const value = Number.parseInt(lower, 10);
      if (Number.isFinite(value) && value > 0) page = value;
    }
  }

  let pageSize = PAGE_SIZE_DEFAULT;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith("limit=") || lower.startsWith("size=")) {
      const rawValue = lower.slice(lower.indexOf("=") + 1);
      const value = Number.parseInt(rawValue, 10);
      if (Number.isFinite(value) && value > 0) pageSize = Math.min(PAGE_SIZE_MAX, value);
    }
  }

  return {
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const body = params.command.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) return null;

  const argText = body.replace(/^\/models\b/i, "").trim();
  const { provider, page, pageSize, all } = parseModelsArgs(argText);

  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  const catalog = await loadModelCatalog({ config: params.cfg });
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault.model,
  });

  const byProvider = new Map<string, Set<string>>();
  const add = (p: string, m: string) => {
    const key = normalizeProviderId(p);
    const set = byProvider.get(key) ?? new Set<string>();
    set.add(m);
    byProvider.set(key, set);
  };

  for (const entry of allowed.allowedCatalog) {
    add(entry.provider, entry.id);
  }

  // Include config-only allowlist keys that aren't in the curated catalog.
  for (const raw of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
    const rawKey = String(raw ?? "").trim();
    if (!rawKey) continue;
    const slash = rawKey.indexOf("/");
    if (slash === -1) continue;
    const p = normalizeProviderId(rawKey.slice(0, slash));
    const m = rawKey.slice(slash + 1).trim();
    if (!p || !m) continue;
    add(p, m);
  }

  const providers = [...byProvider.keys()].sort();

  if (!provider) {
    const lines: string[] = [
      "Providers:",
      ...providers.map((p) =>
        formatProviderLine({ provider: p, count: byProvider.get(p)?.size ?? 0 }),
      ),
      "",
      "Use: /models <provider>",
      "Switch: /model <provider/model>",
    ];
    return { reply: { text: lines.join("\n") }, shouldContinue: false };
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
    return { reply: { text: lines.join("\n") }, shouldContinue: false };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].sort();
  const total = models.length;

  const effectivePageSize = all ? total : pageSize;
  const startIndex = (page - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);

  const header = `Models (${provider}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total}`;

  const lines: string[] = [header];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }

  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;

  lines.push("", "Switch: /model <provider/model>");
  if (!all && page < pageCount) {
    lines.push(`More: /models ${provider} ${page + 1}`);
  }
  if (!all) {
    lines.push(`All: /models ${provider} all`);
  }

  const payload: ReplyPayload = { text: lines.join("\n") };
  return { reply: payload, shouldContinue: false };
};
