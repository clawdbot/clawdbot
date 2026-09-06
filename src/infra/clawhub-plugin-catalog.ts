// ClawHub plugin discovery reads and strict remote response normalization.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  fetchClawHubJson,
  readClawHubStringArrayField,
  readClawHubStringField,
  readRequiredClawHubBooleanField,
  readRequiredClawHubNumberField,
  readRequiredClawHubStringField,
  type ClawHubFetch,
} from "./clawhub-client.js";

export type ClawHubPluginCatalogEntry = {
  packageName: string;
  displayName: string;
  family: "code-plugin" | "bundle-plugin";
  summary?: string;
  ownerHandle?: string;
  isOfficial: boolean;
  categories: string[];
  latestVersion?: string;
  runtimeId?: string;
  downloads?: number;
  installs?: number;
  verificationTier?: string;
};

export type ClawHubPluginCategory = {
  slug: string;
  label: string;
  description: string;
  icon: string;
  order: number;
};

type ClawHubReadOptions = {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
};

const BARE_ICON_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PLUGIN_CATEGORY_ICON_KEYS = new Set([
  "activity",
  "book-open",
  "brain",
  "database",
  "git-branch",
  "globe",
  "message-circle",
  "message-square",
  "package",
  "palette",
  "shield",
  "wrench",
]);

function readOptionalNonNegativeNumber(
  value: Record<string, unknown>,
  field: string,
  context: string,
): number | undefined {
  const candidate = value[field];
  if (candidate === undefined || candidate === null) {
    return undefined;
  }
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw new Error(`Malformed ClawHub ${context}: expected ${field} to be non-negative.`);
  }
  return candidate;
}

function parseCatalogPackage(value: unknown, context: string): ClawHubPluginCatalogEntry {
  if (!isRecord(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected package to be an object.`);
  }
  const family = readRequiredClawHubStringField(value, "family", context);
  if (family !== "code-plugin" && family !== "bundle-plugin") {
    throw new Error(`Malformed ClawHub ${context}: unsupported package family ${family}.`);
  }
  const stats = value.stats;
  if (stats !== undefined && stats !== null && !isRecord(stats)) {
    throw new Error(`Malformed ClawHub ${context}: expected stats to be an object.`);
  }
  const summary = readClawHubStringField(value, "summary", context);
  const ownerHandle = readClawHubStringField(value, "ownerHandle", context);
  const latestVersion = readClawHubStringField(value, "latestVersion", context);
  const runtimeId = readClawHubStringField(value, "runtimeId", context);
  const verificationTier = readClawHubStringField(value, "verificationTier", context);
  const downloads = stats
    ? readOptionalNonNegativeNumber(stats, "downloads", `${context} stats`)
    : undefined;
  const installs = stats
    ? readOptionalNonNegativeNumber(stats, "installs", `${context} stats`)
    : undefined;
  return {
    packageName: readRequiredClawHubStringField(value, "name", context),
    displayName: readRequiredClawHubStringField(value, "displayName", context),
    family,
    isOfficial: readRequiredClawHubBooleanField(value, "isOfficial", context),
    categories: readClawHubStringArrayField(value, "categories", context) ?? [],
    ...(summary ? { summary } : {}),
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    ...(verificationTier ? { verificationTier } : {}),
    ...(downloads !== undefined ? { downloads } : {}),
    ...(installs !== undefined ? { installs } : {}),
  };
}

function parseCatalogList(value: unknown): {
  items: ClawHubPluginCatalogEntry[];
  nextCursor?: string;
} {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("Malformed ClawHub plugin catalog response: expected items to be an array.");
  }
  const nextCursor = readClawHubStringField(value, "nextCursor", "plugin catalog response");
  return {
    items: value.items.map((item, index) =>
      parseCatalogPackage(item, `plugin catalog item ${index}`),
    ),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function parseCatalogSearch(value: unknown): { items: ClawHubPluginCatalogEntry[] } {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("Malformed ClawHub plugin search response: expected results to be an array.");
  }
  return {
    items: value.results.map((result, index) => {
      if (!isRecord(result)) {
        throw new Error(`Malformed ClawHub plugin search result ${index}: expected an object.`);
      }
      return parseCatalogPackage(result.package, `plugin search result ${index}`);
    }),
  };
}

export async function fetchClawHubPluginCatalog(
  params: ClawHubReadOptions & {
    query?: string;
    intent?: "all" | "trending" | "official";
    category?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: ClawHubPluginCatalogEntry[]; nextCursor?: string }> {
  const query = params.query?.trim();
  const shared = {
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  };
  if (query) {
    const value = await fetchClawHubJson<unknown>({
      ...shared,
      path: "/api/v1/plugins/search",
      search: {
        q: query,
        category: params.category,
        isOfficial: params.intent === "official" ? "true" : undefined,
        limit: params.limit ? String(params.limit) : undefined,
      },
    });
    return parseCatalogSearch(value);
  }
  const value = await fetchClawHubJson<unknown>({
    ...shared,
    path: "/api/v1/plugins",
    search: {
      category: params.category,
      cursor: params.cursor,
      isOfficial: params.intent === "official" ? "true" : undefined,
      sort: params.intent === "trending" ? "trending" : "recommended",
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
  return parseCatalogList(value);
}

export async function fetchClawHubPluginCategories(
  options: ClawHubReadOptions = {},
): Promise<ClawHubPluginCategory[]> {
  const value = await fetchClawHubJson<unknown>({
    ...options,
    path: "/api/v1/plugins/categories",
  });
  if (!isRecord(value) || !Array.isArray(value.categories)) {
    throw new Error(
      "Malformed ClawHub plugin categories response: expected categories to be an array.",
    );
  }
  const seenSlugs = new Set<string>();
  const seenOrders = new Set<number>();
  const categories = value.categories.map((entry, index): ClawHubPluginCategory => {
    if (!isRecord(entry)) {
      throw new Error(`Malformed ClawHub plugin category ${index}: expected an object.`);
    }
    const slug = readRequiredClawHubStringField(entry, "slug", `plugin category ${index}`);
    const icon = readRequiredClawHubStringField(entry, "icon", `plugin category ${index}`);
    const order = readRequiredClawHubNumberField(entry, "order", `plugin category ${index}`);
    if (!BARE_ICON_KEY.test(icon)) {
      throw new Error(`Malformed ClawHub plugin category ${slug}: invalid icon key.`);
    }
    if (!Number.isInteger(order) || order < 0 || seenSlugs.has(slug) || seenOrders.has(order)) {
      throw new Error(`Malformed ClawHub plugin category ${slug}: duplicate or invalid ordering.`);
    }
    seenSlugs.add(slug);
    seenOrders.add(order);
    return {
      slug,
      label: readRequiredClawHubStringField(entry, "label", `plugin category ${slug}`),
      description: readRequiredClawHubStringField(entry, "description", `plugin category ${slug}`),
      icon: PLUGIN_CATEGORY_ICON_KEYS.has(icon) ? icon : "package",
      order,
    };
  });
  return categories.toSorted((left, right) => left.order - right.order);
}

export async function fetchClawHubPluginDetail(
  params: ClawHubReadOptions & { packageName: string },
): Promise<ClawHubPluginCatalogEntry> {
  const value = await fetchClawHubJson<unknown>({
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    path: `/api/v1/packages/${encodeURIComponent(params.packageName)}`,
  });
  if (!isRecord(value)) {
    throw new Error("Malformed ClawHub plugin detail response: expected an object.");
  }
  return parseCatalogPackage(value.package, "plugin detail");
}
