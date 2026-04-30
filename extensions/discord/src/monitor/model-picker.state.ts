import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import type { ComponentData } from "../internal/discord.js";

export const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
export const DISCORD_CUSTOM_ID_MAX_CHARS = 100;

export const DISCORD_COMPONENT_MAX_ROWS = 5;
export const DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW = 5;
export const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;

export const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE =
  DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW * (DISCORD_COMPONENT_MAX_ROWS - 1);
export const DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX =
  DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW * DISCORD_COMPONENT_MAX_ROWS;
export const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;

const COMMAND_CONTEXTS = ["model", "models"] as const;
const PICKER_ACTIONS = [
  "open",
  "provider",
  "model",
  "runtime",
  "submit",
  "quick",
  "back",
  "reset",
  "cancel",
  "recents",
] as const;
const PICKER_VIEWS = ["providers", "models", "recents"] as const;

export type DiscordModelPickerCommandContext = (typeof COMMAND_CONTEXTS)[number];
export type DiscordModelPickerAction = (typeof PICKER_ACTIONS)[number];
export type DiscordModelPickerView = (typeof PICKER_VIEWS)[number];
export type DiscordModelPickerLayout = "v2" | "classic";

export type DiscordModelPickerState = {
  command: DiscordModelPickerCommandContext;
  action: DiscordModelPickerAction;
  view: DiscordModelPickerView;
  userId: string;
  provider?: string;
  runtime?: string;
  page: number;
  providerPage?: number;
  modelIndex?: number;
  recentSlot?: number;
};

export type DiscordModelPickerProviderItem = {
  id: string;
  count: number;
};

export type DiscordModelPickerPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type DiscordModelPickerModelPage = DiscordModelPickerPage<string> & {
  provider: string;
};

let modelsProviderRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/models-provider-runtime")>
  | undefined;

async function loadModelsProviderRuntime() {
  modelsProviderRuntimePromise ??= import("openclaw/plugin-sdk/models-provider-runtime");
  return await modelsProviderRuntimePromise;
}

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isValidCommandContext(value: string): value is DiscordModelPickerCommandContext {
  return (COMMAND_CONTEXTS as readonly string[]).includes(value);
}

function isValidPickerAction(value: string): value is DiscordModelPickerAction {
  return (PICKER_ACTIONS as readonly string[]).includes(value);
}

function isValidPickerView(value: string): value is DiscordModelPickerView {
  return (PICKER_VIEWS as readonly string[]).includes(value);
}

export function normalizeModelPickerPage(value: number | undefined): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(1, Math.floor(numeric));
}

function parseRawPage(value: unknown): number {
  if (typeof value === "number") {
    return normalizeModelPickerPage(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return normalizeModelPickerPage(parsed);
    }
  }
  return 1;
}

function parseRawPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return Math.floor(parsed);
}

function coerceString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function clampPageSize(rawPageSize: number | undefined, max: number, fallback: number): number {
  if (!Number.isFinite(rawPageSize)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(rawPageSize ?? fallback)));
}

function paginateItems<T>(params: {
  items: T[];
  page: number;
  pageSize: number;
}): DiscordModelPickerPage<T> {
  const totalItems = params.items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / params.pageSize));
  const page = Math.max(1, Math.min(params.page, totalPages));
  const startIndex = (page - 1) * params.pageSize;
  const endIndexExclusive = Math.min(totalItems, startIndex + params.pageSize);

  return {
    items: params.items.slice(startIndex, endIndexExclusive),
    page,
    pageSize: params.pageSize,
    totalPages,
    totalItems,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

export async function loadDiscordModelPickerData(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<ModelsProviderData> {
  const { buildModelsProviderData } = await loadModelsProviderRuntime();
  return buildModelsProviderData(cfg, agentId);
}

export function buildDiscordModelPickerCustomId(params: {
  command: DiscordModelPickerCommandContext;
  action: DiscordModelPickerAction;
  view: DiscordModelPickerView;
  userId: string;
  provider?: string;
  runtime?: string;
  page?: number;
  providerPage?: number;
  modelIndex?: number;
  recentSlot?: number;
}): string {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error("Discord model picker custom_id requires userId");
  }

  const page = normalizeModelPickerPage(params.page);
  const providerPage =
    typeof params.providerPage === "number" && Number.isFinite(params.providerPage)
      ? Math.max(1, Math.floor(params.providerPage))
      : undefined;
  const normalizedProvider = params.provider ? normalizeProviderId(params.provider) : undefined;
  const modelIndex =
    typeof params.modelIndex === "number" && Number.isFinite(params.modelIndex)
      ? Math.max(1, Math.floor(params.modelIndex))
      : undefined;
  const recentSlot =
    typeof params.recentSlot === "number" && Number.isFinite(params.recentSlot)
      ? Math.max(1, Math.floor(params.recentSlot))
      : undefined;

  const parts = [
    `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${encodeCustomIdValue(params.command)}`,
    `a=${encodeCustomIdValue(params.action)}`,
    `v=${encodeCustomIdValue(params.view)}`,
    `u=${encodeCustomIdValue(userId)}`,
    `g=${String(page)}`,
  ];
  if (normalizedProvider) {
    parts.push(`p=${encodeCustomIdValue(normalizedProvider)}`);
  }
  const runtime = params.runtime?.trim();
  if (runtime) {
    parts.push(`r=${encodeCustomIdValue(runtime)}`);
  }
  if (providerPage) {
    parts.push(`pp=${String(providerPage)}`);
  }
  if (modelIndex) {
    parts.push(`mi=${String(modelIndex)}`);
  }
  if (recentSlot) {
    parts.push(`rs=${String(recentSlot)}`);
  }

  const customId = parts.join(";");
  if (customId.length > DISCORD_CUSTOM_ID_MAX_CHARS) {
    throw new Error(
      `Discord model picker custom_id exceeds ${DISCORD_CUSTOM_ID_MAX_CHARS} chars (${customId.length})`,
    );
  }
  return customId;
}

export function parseDiscordModelPickerCustomId(customId: string): DiscordModelPickerState | null {
  const trimmed = customId.trim();
  if (!trimmed.startsWith(`${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:`)) {
    return null;
  }

  const rawParts = trimmed.split(";");
  const data: Record<string, string> = {};
  for (const part of rawParts) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const rawKey = part.slice(0, equalsIndex);
    const rawValue = part.slice(equalsIndex + 1);
    const key = rawKey.includes(":") ? rawKey.split(":").slice(1).join(":") : rawKey;
    if (!key) {
      continue;
    }
    data[key] = rawValue;
  }

  return parseDiscordModelPickerData(data);
}

export function parseDiscordModelPickerData(data: ComponentData): DiscordModelPickerState | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const command = decodeCustomIdValue(coerceString(data.c ?? data.cmd));
  const action = decodeCustomIdValue(coerceString(data.a ?? data.act));
  const view = decodeCustomIdValue(coerceString(data.v ?? data.view));
  const userId = decodeCustomIdValue(coerceString(data.u));
  const providerRaw = decodeCustomIdValue(coerceString(data.p));
  const runtimeRaw = decodeCustomIdValue(coerceString(data.r));
  const page = parseRawPage(data.g ?? data.pg);
  const providerPage = parseRawPositiveInt(data.pp);
  const modelIndex = parseRawPositiveInt(data.mi);
  const recentSlot = parseRawPositiveInt(data.rs);

  if (!isValidCommandContext(command) || !isValidPickerAction(action) || !isValidPickerView(view)) {
    return null;
  }

  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }

  const provider = providerRaw ? normalizeProviderId(providerRaw) : undefined;
  const runtime = runtimeRaw.trim() || undefined;

  return {
    command,
    action,
    view,
    userId: trimmedUserId,
    provider,
    runtime,
    page,
    ...(typeof providerPage === "number" ? { providerPage } : {}),
    ...(typeof modelIndex === "number" ? { modelIndex } : {}),
    ...(typeof recentSlot === "number" ? { recentSlot } : {}),
  };
}

export function buildDiscordModelPickerProviderItems(
  data: ModelsProviderData,
): DiscordModelPickerProviderItem[] {
  return data.providers.map((provider) => ({
    id: provider,
    count: data.byProvider.get(provider)?.size ?? 0,
  }));
}

export function getDiscordModelPickerProviderPage(params: {
  data: ModelsProviderData;
  page?: number;
  pageSize?: number;
}): DiscordModelPickerPage<DiscordModelPickerProviderItem> {
  const items = buildDiscordModelPickerProviderItems(params.data);
  const canFitSinglePage = items.length <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX;
  const maxPageSize = canFitSinglePage
    ? DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX
    : DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE;
  const pageSize = clampPageSize(params.pageSize, maxPageSize, maxPageSize);
  return paginateItems({
    items,
    page: normalizeModelPickerPage(params.page),
    pageSize,
  });
}

export function getDiscordModelPickerModelPage(params: {
  data: ModelsProviderData;
  provider: string;
  page?: number;
  pageSize?: number;
}): DiscordModelPickerModelPage | null {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return null;
  }

  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  );
  const models = [...modelSet].toSorted();
  const page = paginateItems({
    items: models,
    page: normalizeModelPickerPage(params.page),
    pageSize,
  });

  return {
    ...page,
    provider,
  };
}
