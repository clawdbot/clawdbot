// ClawHub plugin discovery reads and strict remote response normalization.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createClawHubError,
  decodeClawHubResponseBody,
  fetchClawHubJson,
  readClawHubBytes,
  readClawHubStringArrayField,
  readClawHubStringField,
  readRequiredClawHubBooleanField,
  readRequiredClawHubNumberField,
  readRequiredClawHubStringField,
  requestClawHub,
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

export type ClawHubPluginDetail = ClawHubPluginCatalogEntry & {
  owner?: { handle?: string; displayName?: string };
  topics: string[];
  createdAt?: number;
  updatedAt?: number;
  readme?: string;
  compatibility?: ClawHubPluginCompatibility;
  configFields: ClawHubPluginConfigField[];
  mcpServers: string[];
  skills: Array<{ name: string; description?: string }>;
  versions: ClawHubPluginVersion[];
  verification?: ClawHubPluginVerification;
  security?: ClawHubPluginSecurity;
};

type ClawHubPluginCompatibility = {
  pluginApiRange?: string;
  builtWithOpenClawVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};

type ClawHubPluginConfigField = {
  name: string;
  description?: string;
  required: boolean;
  sensitive: boolean;
};

type ClawHubPluginVersion = {
  version: string;
  createdAt: number;
  changelog: string;
  tags: string[];
};

type ClawHubPluginVerification = {
  tier: string;
  summary?: string;
  sourceRepo?: string;
  sourceCommit?: string;
  sourcePath?: string;
  scanStatus?: string;
};

type ClawHubPluginSecurity = {
  status: string;
  verdict?: string;
  summary?: string;
  guidance?: string;
  checkedAt?: number;
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

function readOptionalRecord(
  source: Record<string, unknown>,
  field: string,
  context: string,
): Record<string, unknown> | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected ${field} to be an object.`);
  }
  return value;
}

function readRequiredBoolean(
  source: Record<string, unknown>,
  field: string,
  context: string,
): boolean {
  return readRequiredClawHubBooleanField(source, field, context);
}

function parseCompatibility(
  value: Record<string, unknown> | undefined,
  context: string,
): ClawHubPluginCompatibility | undefined {
  if (!value) {
    return undefined;
  }
  const compatibility = {
    pluginApiRange: readClawHubStringField(value, "pluginApiRange", context),
    builtWithOpenClawVersion: readClawHubStringField(value, "builtWithOpenClawVersion", context),
    pluginSdkVersion: readClawHubStringField(value, "pluginSdkVersion", context),
    minGatewayVersion: readClawHubStringField(value, "minGatewayVersion", context),
  };
  const entries = Object.entries(compatibility).filter((entry): entry is [string, string] =>
    Boolean(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseManifest(value: Record<string, unknown> | undefined): {
  compatibility?: ClawHubPluginCompatibility;
  configFields: ClawHubPluginConfigField[];
  mcpServers: string[];
  skills: Array<{ name: string; description?: string }>;
} {
  if (!value) {
    return { configFields: [], mcpServers: [], skills: [] };
  }
  const configFields = value.configFields;
  const mcpServers = value.mcpServers;
  const bundledSkills = value.bundledSkills;
  if (!Array.isArray(configFields) || !Array.isArray(mcpServers) || !Array.isArray(bundledSkills)) {
    throw new Error("Malformed ClawHub plugin manifest summary: expected capability arrays.");
  }
  const compatibility = parseCompatibility(
    readOptionalRecord(value, "compatibility", "plugin manifest summary"),
    "plugin manifest compatibility",
  );
  return {
    ...(compatibility ? { compatibility } : {}),
    configFields: configFields.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(`Malformed ClawHub plugin config field ${index}: expected an object.`);
      }
      const description = readClawHubStringField(
        entry,
        "description",
        `plugin config field ${index}`,
      );
      const field: ClawHubPluginConfigField = {
        name: readRequiredClawHubStringField(entry, "name", `plugin config field ${index}`),
        required: readRequiredBoolean(entry, "required", `plugin config field ${index}`),
        sensitive: readRequiredBoolean(entry, "sensitive", `plugin config field ${index}`),
      };
      if (description) {
        field.description = description;
      }
      return field;
    }),
    mcpServers: mcpServers.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(`Malformed ClawHub plugin MCP server ${index}: expected an object.`);
      }
      return readRequiredClawHubStringField(entry, "name", `plugin MCP server ${index}`);
    }),
    skills: bundledSkills.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(`Malformed ClawHub bundled skill ${index}: expected an object.`);
      }
      const description = readClawHubStringField(entry, "description", `bundled skill ${index}`);
      const skill: { name: string; description?: string } = {
        name: readRequiredClawHubStringField(entry, "name", `bundled skill ${index}`),
      };
      if (description) {
        skill.description = description;
      }
      return skill;
    }),
  };
}

function parseVerification(
  value: Record<string, unknown> | undefined,
): ClawHubPluginVerification | undefined {
  if (!value) {
    return undefined;
  }
  const summary = readClawHubStringField(value, "summary", "plugin verification");
  const sourceRepo = readClawHubStringField(value, "sourceRepo", "plugin verification");
  const sourceCommit = readClawHubStringField(value, "sourceCommit", "plugin verification");
  const sourcePath = readClawHubStringField(value, "sourcePath", "plugin verification");
  const scanStatus = readClawHubStringField(value, "scanStatus", "plugin verification");
  return {
    tier: readRequiredClawHubStringField(value, "tier", "plugin verification"),
    ...(summary ? { summary } : {}),
    ...(sourceRepo ? { sourceRepo } : {}),
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(scanStatus ? { scanStatus } : {}),
  };
}

function parseSecurity(
  value: Record<string, unknown> | undefined,
): ClawHubPluginSecurity | undefined {
  if (!value) {
    return undefined;
  }
  const verdict = readClawHubStringField(value, "verdict", "plugin security analysis");
  const summary = readClawHubStringField(value, "summary", "plugin security analysis");
  const guidance = readClawHubStringField(value, "guidance", "plugin security analysis");
  const checkedAt = readOptionalNonNegativeNumber(value, "checkedAt", "plugin security analysis");
  return {
    status: readRequiredClawHubStringField(value, "status", "plugin security analysis"),
    ...(verdict ? { verdict } : {}),
    ...(summary ? { summary } : {}),
    ...(guidance ? { guidance } : {}),
    ...(checkedAt !== undefined ? { checkedAt } : {}),
  };
}

function parseVersions(value: unknown): ClawHubPluginVersion[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("Malformed ClawHub plugin versions response: expected items to be an array.");
  }
  return value.items.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Malformed ClawHub plugin version ${index}: expected an object.`);
    }
    const changelog = readClawHubStringField(entry, "changelog", `plugin version ${index}`);
    return {
      version: readRequiredClawHubStringField(entry, "version", `plugin version ${index}`),
      createdAt: readRequiredClawHubNumberField(entry, "createdAt", `plugin version ${index}`),
      changelog: changelog ?? "",
      tags: readClawHubStringArrayField(entry, "distTags", `plugin version ${index}`) ?? [],
    };
  });
}

async function fetchOptionalReadme(
  params: ClawHubReadOptions & { packageName: string; version?: string },
): Promise<string | undefined> {
  const { response, url, hasToken } = await requestClawHub({
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    path: `/api/v1/packages/${encodeURIComponent(params.packageName)}/file`,
    search: {
      path: "README.md",
      preview: "1",
      version: params.version,
    },
    headers: { Accept: "text/plain" },
  });
  if ([403, 404, 415, 423].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok) {
    throw await createClawHubError(response, url, hasToken, params.timeoutMs);
  }
  const bytes = await readClawHubBytes({
    response,
    maxBytes: 512 * 1024,
    timeoutMs: params.timeoutMs,
    resourceLabel: `${url.pathname} README`,
  });
  return decodeClawHubResponseBody(bytes);
}

export async function fetchClawHubPluginCatalog(
  params: ClawHubReadOptions & {
    query?: string;
    intent?: "all" | "trending" | "official" | "featured";
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
      featured: params.intent === "featured" ? "true" : undefined,
      isOfficial: params.intent === "official" ? "true" : undefined,
      sort:
        params.intent === "featured"
          ? undefined
          : params.intent === "trending"
            ? "trending"
            : "recommended",
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
): Promise<ClawHubPluginDetail> {
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
  if (!isRecord(value.package)) {
    throw new Error("Malformed ClawHub plugin detail response: expected package to be an object.");
  }
  const catalog = parseCatalogPackage(value.package, "plugin detail");
  const topics = readClawHubStringArrayField(value.package, "topics", "plugin detail") ?? [];
  const createdAt = readOptionalNonNegativeNumber(value.package, "createdAt", "plugin detail");
  const updatedAt = readOptionalNonNegativeNumber(value.package, "updatedAt", "plugin detail");
  const packageCompatibility = parseCompatibility(
    readOptionalRecord(value.package, "compatibility", "plugin detail"),
    "plugin compatibility",
  );
  const ownerRecord = readOptionalRecord(value, "owner", "plugin detail response");
  const ownerHandle = ownerRecord
    ? readClawHubStringField(ownerRecord, "handle", "plugin owner")
    : undefined;
  const ownerDisplayName = ownerRecord
    ? readClawHubStringField(ownerRecord, "displayName", "plugin owner")
    : undefined;

  const shared = {
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  };
  const version = catalog.latestVersion;
  const [versionsValue, versionValue, readme] = await Promise.all([
    fetchClawHubJson<unknown>({
      ...shared,
      path: `/api/v1/packages/${encodeURIComponent(params.packageName)}/versions`,
      search: { limit: "10" },
    }),
    version
      ? fetchClawHubJson<unknown>({
          ...shared,
          path: `/api/v1/packages/${encodeURIComponent(params.packageName)}/versions/${encodeURIComponent(version)}`,
        })
      : Promise.resolve(undefined),
    fetchOptionalReadme({ ...shared, packageName: params.packageName, version }),
  ]);
  if (versionValue !== undefined && !isRecord(versionValue)) {
    throw new Error("Malformed ClawHub plugin version response: expected an object.");
  }
  const versionRecord = versionValue
    ? readOptionalRecord(versionValue, "version", "plugin version response")
    : undefined;
  const manifest = parseManifest(
    versionRecord
      ? readOptionalRecord(versionRecord, "pluginManifestSummary", "plugin version")
      : readOptionalRecord(value.package, "pluginManifestSummary", "plugin detail"),
  );
  const verification = parseVerification(
    versionRecord
      ? readOptionalRecord(versionRecord, "verification", "plugin version")
      : readOptionalRecord(value.package, "verification", "plugin detail"),
  );
  const security = parseSecurity(
    versionRecord ? readOptionalRecord(versionRecord, "llmAnalysis", "plugin version") : undefined,
  );
  const owner = {
    ...(ownerHandle ? { handle: ownerHandle } : {}),
    ...(ownerDisplayName ? { displayName: ownerDisplayName } : {}),
  };
  return {
    ...catalog,
    ...(ownerHandle && !catalog.ownerHandle ? { ownerHandle } : {}),
    ...(Object.keys(owner).length > 0 ? { owner } : {}),
    topics,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(readme ? { readme } : {}),
    ...((manifest.compatibility ?? packageCompatibility)
      ? { compatibility: manifest.compatibility ?? packageCompatibility }
      : {}),
    configFields: manifest.configFields,
    mcpServers: manifest.mcpServers,
    skills: manifest.skills,
    versions: parseVersions(versionsValue),
    ...(verification ? { verification } : {}),
    ...(security ? { security } : {}),
  };
}
