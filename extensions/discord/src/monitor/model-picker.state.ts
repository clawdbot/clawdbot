import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import type { ComponentData } from "../internal/discord.js";

export const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
export const DISCORD_CUSTOM_ID_MAX_CHARS = 100;

export const DISCORD_COMPONENT_MAX_ROWS = 5;
export const DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW = 5;
export const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;

export const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;
export const DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;
export const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;

function compareBucketItems(left: string, right: string): number {
  const normalized = left.toLowerCase().localeCompare(right.toLowerCase());
  return normalized === 0 ? left.localeCompare(right) : normalized;
}

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
  "nav",
  "bucket",
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
  runtimeIndex?: number;
  page: number;
  providerPage?: number;
  modelIndex?: number;
  recentSlot?: number;
  /**
   * Letter-range bucket label (e.g. "a-g") when the provider/model count
   * exceeds {@link DISCORD_MODEL_PICKER_BUCKET_THRESHOLD}. Filters the
   * sorted item list to a single bucket before page-level pagination kicks
   * in. Omitted = "all" / single bucket.
   */
  providerBucket?: string;
  modelBucket?: string;
};

/**
 * Alpha buckets engage only when the sorted item list exceeds the single-page
 * select cap. Below this threshold the user gets the existing flat list +
 * prev/next behavior unchanged.
 */
export const DISCORD_MODEL_PICKER_BUCKET_THRESHOLD = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;

/** Target items per alpha bucket. Discord caps selects at 25 options. */
export const DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE = 20;

export type DiscordModelPickerBucket = {
  /** Stable lowercase id, e.g. "a-g". Used in customId encoding. */
  id: string;
  /** Human label with count, e.g. "A–G (12)". */
  label: string;
  /** Inclusive start index into the sorted item list. */
  start: number;
  /** Exclusive end index into the sorted item list. */
  end: number;
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
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) {
      return normalizeModelPickerPage(parsed);
    }
  }
  return 1;
}

function parseRawPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const raw = String(value).trim();
  if (!/^[+]?\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
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
  runtimeIndex?: number;
  page?: number;
  providerPage?: number;
  modelIndex?: number;
  recentSlot?: number;
  providerBucket?: string;
  modelBucket?: string;
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
  const runtimeIndex =
    typeof params.runtimeIndex === "number" && Number.isFinite(params.runtimeIndex)
      ? Math.max(1, Math.floor(params.runtimeIndex))
      : undefined;
  if (runtimeIndex) {
    parts.push(`ri=${String(runtimeIndex)}`);
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
  const providerBucket = params.providerBucket?.trim().toLowerCase();
  if (providerBucket) {
    parts.push(`pb=${encodeCustomIdValue(providerBucket)}`);
  }
  const modelBucket = params.modelBucket?.trim().toLowerCase();
  if (modelBucket) {
    parts.push(`mb=${encodeCustomIdValue(modelBucket)}`);
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
  const runtimeIndex = parseRawPositiveInt(data.ri);
  const page = parseRawPage(data.g ?? data.pg);
  const providerPage = parseRawPositiveInt(data.pp);
  const modelIndex = parseRawPositiveInt(data.mi);
  const recentSlot = parseRawPositiveInt(data.rs);
  const providerBucketRaw = decodeCustomIdValue(coerceString(data.pb)).trim().toLowerCase();
  const modelBucketRaw = decodeCustomIdValue(coerceString(data.mb)).trim().toLowerCase();

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
    ...(typeof runtimeIndex === "number" ? { runtimeIndex } : {}),
    page,
    ...(typeof providerPage === "number" ? { providerPage } : {}),
    ...(typeof modelIndex === "number" ? { modelIndex } : {}),
    ...(typeof recentSlot === "number" ? { recentSlot } : {}),
    ...(providerBucketRaw ? { providerBucket: providerBucketRaw } : {}),
    ...(modelBucketRaw ? { modelBucket: modelBucketRaw } : {}),
  };
}

/**
 * Split a sorted item list into letter-range buckets when its length exceeds
 * {@link DISCORD_MODEL_PICKER_BUCKET_THRESHOLD}. Items below the threshold
 * return a single "All" bucket so callers can render the same code path.
 *
 * The boundary extender keeps items sharing the same starting letter inside
 * the same bucket — selecting "A–G" never strands a stray "g" item in the
 * next bucket. If every item shares a first letter (e.g. all `qwen3-*`),
 * the function falls back to count-based numeric chunks so the user still
 * gets a finite-cardinality picker.
 */
export function computeAlphaBuckets(sortedItems: string[]): DiscordModelPickerBucket[] {
  if (sortedItems.length === 0) {
    return [];
  }
  if (sortedItems.length <= DISCORD_MODEL_PICKER_BUCKET_THRESHOLD) {
    return [
      {
        id: "all",
        label: `All (${sortedItems.length})`,
        start: 0,
        end: sortedItems.length,
      },
    ];
  }

  const firstLetter = (value: string): string => value.charAt(0).toLowerCase();
  const allSamePrefix = sortedItems.every(
    (item) => firstLetter(item) === firstLetter(sortedItems[0]),
  );
  if (allSamePrefix) {
    return chunkBucketsByCount(sortedItems);
  }

  const buckets: DiscordModelPickerBucket[] = [];
  // Cap bucket count at the Discord select-option limit. Without this a very
  // large list (e.g. 600+ diverse items) would yield >25 buckets and the
  // bucket select itself would exceed Discord's hard 25-option cap. The
  // letter-boundary extender below can only grow buckets (never split
  // letter groups), so sizing the base target to a 25-bucket ceiling
  // remains safe even after extension.
  const target = computeBucketTargetSize(sortedItems.length);
  let start = 0;
  while (start < sortedItems.length) {
    let end = Math.min(sortedItems.length, start + target);
    // Extend `end` so we don't split a letter group across two buckets.
    if (end < sortedItems.length) {
      const last = firstLetter(sortedItems[end - 1]);
      while (end < sortedItems.length && firstLetter(sortedItems[end]) === last) {
        end += 1;
      }
    }
    const startLetter = firstLetter(sortedItems[start]);
    const endLetter = firstLetter(sortedItems[end - 1]);
    const id = startLetter === endLetter ? startLetter : `${startLetter}-${endLetter}`;
    const label =
      startLetter === endLetter
        ? `${startLetter.toUpperCase()} (${end - start})`
        : `${startLetter.toUpperCase()}–${endLetter.toUpperCase()} (${end - start})`;
    buckets.push({ id, label, start, end });
    start = end;
  }
  return buckets;
}

/**
 * Pick the per-bucket target size such that the resulting bucket count never
 * exceeds {@link DISCORD_COMPONENT_MAX_SELECT_OPTIONS} (Discord's hard select
 * cap). Stays at the default {@link DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE}
 * for typical inputs and grows linearly for very large lists.
 */
function computeBucketTargetSize(totalItems: number): number {
  const minTarget = DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE;
  const capByBucketCount = Math.ceil(totalItems / DISCORD_COMPONENT_MAX_SELECT_OPTIONS);
  return Math.max(minTarget, capByBucketCount);
}

function chunkBucketsByCount(sortedItems: string[]): DiscordModelPickerBucket[] {
  const buckets: DiscordModelPickerBucket[] = [];
  const target = computeBucketTargetSize(sortedItems.length);
  for (let start = 0; start < sortedItems.length; start += target) {
    const end = Math.min(sortedItems.length, start + target);
    buckets.push({
      id: `${start + 1}-${end}`,
      label: `${start + 1}–${end} (${end - start})`,
      start,
      end,
    });
  }
  return buckets;
}

/**
 * Resolve a bucket from a list given a (possibly user-supplied) bucket id.
 * Falls back to the first bucket when the id does not match — mirrors the
 * "bad customId → reset to defaults" semantics already used for other
 * state fields.
 */
export function resolveBucket(
  buckets: DiscordModelPickerBucket[],
  id: string | undefined,
): DiscordModelPickerBucket | null {
  if (buckets.length === 0) {
    return null;
  }
  if (!id) {
    return buckets[0];
  }
  return buckets.find((bucket) => bucket.id === id) ?? buckets[0];
}

/**
 * Derive the alpha-bucket id that contains a given provider id. Returns
 * `undefined` when bucketing is inactive (all providers fit in one bucket)
 * or the provider is unknown. Used by the interaction handler to recompute
 * `providerBucket` at re-render time without forcing every customId to
 * carry the bucket field — the bucket is a pure function of the provider
 * list + provider id.
 */
export function findProviderBucketId(
  data: ModelsProviderData,
  provider: string,
): string | undefined {
  return findProviderBucketLocation(data, provider)?.bucket;
}

export function findProviderBucketLocation(
  data: ModelsProviderData,
  provider: string,
): { bucket?: string; page: number } | undefined {
  const normalized = normalizeProviderId(provider);
  const sorted = [...data.providers].toSorted();
  const idx = sorted.indexOf(normalized);
  if (idx < 0) {
    return undefined;
  }
  const buckets = computeAlphaBuckets(sorted);
  const containing = buckets.find((bucket) => idx >= bucket.start && idx < bucket.end);
  if (!containing) {
    return undefined;
  }
  const page = Math.floor((idx - containing.start) / DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE) + 1;
  return {
    ...(containing.id !== "all" ? { bucket: containing.id } : {}),
    page,
  };
}

/**
 * Derive the alpha-bucket id that contains a given model id within the
 * named provider. Same rationale as {@link findProviderBucketId} — saves
 * customId budget by recomputing the bucket from the durable state
 * (provider + model) rather than carrying it as a parameter.
 */
export function findModelBucketId(
  data: ModelsProviderData,
  provider: string,
  model: string,
): string | undefined {
  const modelSet = data.byProvider.get(normalizeProviderId(provider));
  if (!modelSet) {
    return undefined;
  }
  const sorted = [...modelSet].toSorted(compareBucketItems);
  const idx = sorted.indexOf(model);
  if (idx < 0) {
    return undefined;
  }
  const buckets = computeAlphaBuckets(sorted);
  const containing = buckets.find((bucket) => idx >= bucket.start && idx < bucket.end);
  return containing && containing.id !== "all" ? containing.id : undefined;
}

export function buildDiscordModelPickerProviderItems(
  data: ModelsProviderData,
): DiscordModelPickerProviderItem[] {
  // Sort lexicographically so the alpha-bucket boundaries are deterministic
  // for any caller that derives buckets from `data.providers`.
  return [...data.providers].toSorted().map((provider) => ({
    id: provider,
    count: data.byProvider.get(provider)?.size ?? 0,
  }));
}

export function getDiscordModelPickerProviderPage(params: {
  data: ModelsProviderData;
  page?: number;
  pageSize?: number;
  bucket?: string;
}): DiscordModelPickerPage<DiscordModelPickerProviderItem> & {
  bucket: DiscordModelPickerBucket | null;
  buckets: DiscordModelPickerBucket[];
} {
  const allItems = buildDiscordModelPickerProviderItems(params.data);
  const buckets = computeAlphaBuckets(allItems.map((item) => item.id));
  const bucket = resolveBucket(buckets, params.bucket);
  const bucketItems = bucket ? allItems.slice(bucket.start, bucket.end) : allItems;

  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE,
    DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE,
  );
  const page = paginateItems({
    items: bucketItems,
    page: normalizeModelPickerPage(params.page),
    pageSize,
  });
  return { ...page, bucket, buckets };
}

export function getDiscordModelPickerModelPage(params: {
  data: ModelsProviderData;
  provider: string;
  page?: number;
  pageSize?: number;
  bucket?: string;
}):
  | (DiscordModelPickerModelPage & {
      bucket: DiscordModelPickerBucket | null;
      buckets: DiscordModelPickerBucket[];
    })
  | null {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return null;
  }

  const allModels = [...modelSet].toSorted(compareBucketItems);
  const buckets = computeAlphaBuckets(allModels);
  const bucket = resolveBucket(buckets, params.bucket);
  const bucketItems = bucket ? allModels.slice(bucket.start, bucket.end) : allModels;

  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  );
  const page = paginateItems({
    items: bucketItems,
    page: normalizeModelPickerPage(params.page),
    pageSize,
  });

  return {
    ...page,
    provider,
    bucket,
    buckets,
  };
}

export function resolveDiscordModelPickerPageForModel(params: {
  data: ModelsProviderData;
  provider: string;
  model: string;
  pageSize?: number;
}): { page: number; bucket?: string } {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return { page: 1 };
  }
  const sorted = [...modelSet].toSorted(compareBucketItems);
  const index = sorted.indexOf(params.model);
  if (index < 0) {
    return { page: 1 };
  }
  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  );
  const buckets = computeAlphaBuckets(sorted);
  const containingBucket = buckets.find((bucket) => index >= bucket.start && index < bucket.end);
  if (!containingBucket) {
    return { page: Math.floor(index / pageSize) + 1 };
  }
  const offsetInBucket = index - containingBucket.start;
  return {
    page: Math.floor(offsetInBucket / pageSize) + 1,
    bucket: containingBucket.id === "all" ? undefined : containingBucket.id,
  };
}
