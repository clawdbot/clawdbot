/** Coverage tests for secrets runtime collector breadth and target surfaces. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginOrigin,
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import { canonicalizeSecretTargetCoverageId } from "./target-registry-test-helpers.js";

const COVERAGE_WEB_PROVIDER_PLUGIN_IDS = vi.hoisted(() => ({
  search: [
    "brave",
    "exa",
    "firecrawl",
    "google",
    "minimax",
    "moonshot",
    "parallel",
    "perplexity",
    "tavily",
    "xai",
  ],
  fetch: ["firecrawl"],
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: () => ({}),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => {
    throw new Error("runtime coverage expects bundled channel secret contracts");
  },
}));

vi.mock("./runtime-web-tools-manifest.runtime.js", () => ({
  resolveManifestContractPluginIds: ({ contract }: { contract: string }) => {
    if (contract === "webSearchProviders") {
      return [...COVERAGE_WEB_PROVIDER_PLUGIN_IDS.search];
    }
    if (contract === "webFetchProviders") {
      return [...COVERAGE_WEB_PROVIDER_PLUGIN_IDS.fetch];
    }
    return [];
  },
}));

function createCoverageWebSearchProvider(params: {
  pluginId: string;
  id: string;
  envVar: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  const readConfiguredCredential = (config?: OpenClawConfig): unknown =>
    (config?.plugins?.entries?.[params.pluginId]?.config as { webSearch?: { apiKey?: unknown } })
      ?.webSearch?.apiKey;
  return {
    pluginId: params.pluginId,
    id: params.id,
    label: params.id,
    hint: `${params.id} coverage provider`,
    envVars: [params.envVar],
    placeholder: `${params.id}-key`,
    signupUrl: `https://example.com/${params.id}`,
    autoDetectOrder: params.order,
    credentialPath,
    inactiveSecretPaths: [credentialPath],
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: readConfiguredCredential,
    setConfiguredCredentialValue: (configTarget, value) => {
      setPathCreateStrict(
        configTarget,
        ["plugins", "entries", params.pluginId, "config", "webSearch", "apiKey"],
        value,
      );
    },
    createTool: () => null,
  };
}

function createCoverageWebFetchProvider(params: {
  pluginId: string;
  id: string;
  envVar: string;
}): PluginWebFetchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webFetch.apiKey`;
  const readConfiguredCredential = (config?: OpenClawConfig): unknown =>
    (config?.plugins?.entries?.[params.pluginId]?.config as { webFetch?: { apiKey?: unknown } })
      ?.webFetch?.apiKey;
  return {
    pluginId: params.pluginId,
    id: params.id,
    label: params.id,
    hint: `${params.id} coverage fetch provider`,
    envVars: [params.envVar],
    placeholder: `${params.id}-key`,
    signupUrl: `https://example.com/${params.id}`,
    autoDetectOrder: 10,
    credentialPath,
    inactiveSecretPaths: [credentialPath],
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: readConfiguredCredential,
    setConfiguredCredentialValue: (configTarget, value) => {
      setPathCreateStrict(
        configTarget,
        ["plugins", "entries", params.pluginId, "config", "webFetch", "apiKey"],
        value,
      );
    },
    createTool: () => null,
  };
}

const COVERAGE_WEB_SEARCH_PROVIDERS = new Map(
  [
    createCoverageWebSearchProvider({
      pluginId: "brave",
      id: "brave",
      envVar: "BRAVE_API_KEY",
      order: 10,
    }),
    createCoverageWebSearchProvider({
      pluginId: "google",
      id: "gemini",
      envVar: "GEMINI_API_KEY",
      order: 20,
    }),
    createCoverageWebSearchProvider({
      pluginId: "xai",
      id: "grok",
      envVar: "XAI_API_KEY",
      order: 30,
    }),
    createCoverageWebSearchProvider({
      pluginId: "moonshot",
      id: "kimi",
      envVar: "MOONSHOT_API_KEY",
      order: 40,
    }),
    createCoverageWebSearchProvider({
      pluginId: "perplexity",
      id: "perplexity",
      envVar: "PERPLEXITY_API_KEY",
      order: 50,
    }),
    createCoverageWebSearchProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      envVar: "FIRECRAWL_API_KEY",
      order: 60,
    }),
    createCoverageWebSearchProvider({
      pluginId: "exa",
      id: "exa",
      envVar: "EXA_API_KEY",
      order: 65,
    }),
    createCoverageWebSearchProvider({
      pluginId: "minimax",
      id: "minimax",
      envVar: "MINIMAX_API_KEY",
      order: 70,
    }),
    createCoverageWebSearchProvider({
      pluginId: "parallel",
      id: "parallel",
      envVar: "PARALLEL_API_KEY",
      order: 75,
    }),
    createCoverageWebSearchProvider({
      pluginId: "tavily",
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      order: 80,
    }),
  ].map((provider) => [provider.pluginId, provider]),
);

const COVERAGE_WEB_FETCH_PROVIDERS = new Map(
  [
    createCoverageWebFetchProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      envVar: "FIRECRAWL_API_KEY",
    }),
  ].map((provider) => [provider.pluginId, provider]),
);

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  loadBundledWebFetchProviderEntriesFromDir: (params: { pluginId: string }) => {
    const provider = COVERAGE_WEB_FETCH_PROVIDERS.get(params.pluginId);
    return provider ? [provider] : null;
  },
  loadBundledWebSearchProviderEntriesFromDir: (params: { pluginId: string }) => {
    const provider = COVERAGE_WEB_SEARCH_PROVIDERS.get(params.pluginId);
    return provider ? [provider] : null;
  },
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: (params: {
    onlyPluginIds: readonly string[];
  }) => {
    const providers = params.onlyPluginIds.map((pluginId) =>
      COVERAGE_WEB_FETCH_PROVIDERS.get(pluginId),
    );
    return providers.every(
      (provider): provider is PluginWebFetchProviderEntry => provider !== undefined,
    )
      ? providers
      : null;
  },
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: (params: {
    onlyPluginIds: readonly string[];
  }) => {
    const providers = params.onlyPluginIds.map((pluginId) =>
      COVERAGE_WEB_SEARCH_PROVIDERS.get(pluginId),
    );
    return providers.every(
      (provider): provider is PluginWebSearchProviderEntry => provider !== undefined,
    )
      ? providers
      : null;
  },
}));

type SecretRegistryEntry = {
  id: string;
  configFile: "openclaw.json" | "auth-profiles.json";
  pathPattern: string;
  refPathPattern?: string;
  secretShape: "secret_input" | "sibling_ref";
  expectedResolvedValue: "string";
  authProfileType?: "api_key" | "token";
};

type SecretRefCredentialMatrix = {
  entries: Array<{
    id: string;
    configFile: "openclaw.json" | "auth-profiles.json";
    path: string;
    refPath?: string;
    secretShape: SecretRegistryEntry["secretShape"];
    when?: {
      type?: SecretRegistryEntry["authProfileType"];
    };
  }>;
};

function loadCoverageRegistryEntries(): SecretRegistryEntry[] {
  const matrixPath = path.join(
    process.cwd(),
    "docs",
    "reference",
    "secretref-user-supplied-credentials-matrix.json",
  );
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as SecretRefCredentialMatrix;
  return matrix.entries.map((entry) =>
    Object.assign(
      { id: entry.id, configFile: entry.configFile, pathPattern: entry.path },
      entry.refPath ? { refPathPattern: entry.refPath } : {},
      { secretShape: entry.secretShape, expectedResolvedValue: "string" as const },
      entry.when?.type ? { authProfileType: entry.when.type } : {},
    ),
  );
}

const COVERAGE_REGISTRY_ENTRIES = loadCoverageRegistryEntries();
const DEBUG_COVERAGE_BATCHES = process.env.OPENCLAW_DEBUG_RUNTIME_COVERAGE === "1";
const RUNTIME_COVERAGE_TEST_TIMEOUT_MS = 240_000;
const COVERAGE_CONFIG_PLUGIN_SOURCE_DIRS = new Map([
  ["google-meet", path.join(process.cwd(), "extensions", "google-meet")],
  ["voice-call", path.join(process.cwd(), "extensions", "voice-call")],
]);
const COVERAGE_LOADABLE_PLUGIN_ORIGINS =
  buildCoverageLoadablePluginOrigins(COVERAGE_REGISTRY_ENTRIES);
const PLUGIN_OWNED_OPENCLAW_COVERAGE_EXCLUSIONS = new Set([
  "channels.googlechat.accounts.*.serviceAccount",
  // Doctor migrates legacy web search config into plugin-owned webSearch config.
  "tools.web.search.apiKey",
  "tools.web.search.*.apiKey",
  "tools.web.fetch.firecrawl.apiKey",
]);

let applyResolvedAssignments: typeof import("./runtime-shared.js").applyResolvedAssignments;
let collectAuthStoreAssignments: typeof import("./runtime-auth-collectors.js").collectAuthStoreAssignments;
let collectConfigAssignments: typeof import("./runtime-config-collectors.js").collectConfigAssignments;
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveSecretRefValues: typeof import("./resolve.js").resolveSecretRefValues;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;
const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const previousTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ??= "extensions";
process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR ??= "1";

afterAll(() => {
  if (previousBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
  }
  if (previousTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = previousTrustBundledPluginsDir;
  }
});

async function ensureConfigCoverageRuntimeLoaded(): Promise<void> {
  if (!collectConfigAssignments) {
    ({ collectConfigAssignments } = await import("./runtime-config-collectors.js"));
  }
}

async function ensureAuthCoverageRuntimeLoaded(): Promise<void> {
  if (!collectAuthStoreAssignments) {
    ({ collectAuthStoreAssignments } = await import("./runtime-auth-collectors.js"));
  }
}

async function ensureRuntimeWebToolsLoaded(): Promise<void> {
  if (!resolveRuntimeWebTools) {
    ({ resolveRuntimeWebTools } = await import("./runtime-web-tools.js"));
  }
}

function toConcretePathSegments(pathPattern: string, wildcardToken = "sample"): string[] {
  const out: string[] = [];
  for (const segment of pathPattern.split(".")) {
    if (!segment) {
      continue;
    }
    if (segment === "*") {
      out.push(wildcardToken);
      continue;
    }
    if (segment.endsWith("[]")) {
      out.push(segment.slice(0, -2), "0");
      continue;
    }
    out.push(segment);
  }
  return out;
}

function resolveCoverageEnvId(entry: SecretRegistryEntry, fallbackEnvId: string): string {
  return entry.id === "plugins.entries.firecrawl.config.webFetch.apiKey" ||
    entry.id === "tools.web.fetch.firecrawl.apiKey"
    ? "FIRECRAWL_API_KEY"
    : fallbackEnvId;
}

function toCoverageEnvRefId(prefix: string, id: string): string {
  const normalized = id
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const name = normalized || "TARGET";
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12).toUpperCase();
  const maxNameLength = 128 - prefix.length - hash.length - 2;
  return `${prefix}_${name.slice(0, Math.max(1, maxNameLength))}_${hash}`;
}

function resolveCoverageResolvedPath(entry: SecretRegistryEntry): string {
  return canonicalizeSecretTargetCoverageId(entry.id);
}

function resolveCoverageWildcardToken(index: number): string {
  return `sample-${index}`;
}

function resolveCoverageResolvedSegments(
  entry: SecretRegistryEntry,
  wildcardToken: string,
): string[] {
  return toConcretePathSegments(resolveCoverageResolvedPath(entry), wildcardToken);
}

function buildCoverageLoadablePluginOrigins(
  entries: readonly SecretRegistryEntry[],
): ReadonlyMap<string, PluginOrigin> {
  const origins = new Map<string, PluginOrigin>();
  for (const entry of entries) {
    const [scope, entriesKey, pluginId] = entry.id.split(".");
    if (scope === "plugins" && entriesKey === "entries" && pluginId) {
      origins.set(
        pluginId,
        COVERAGE_CONFIG_PLUGIN_SOURCE_DIRS.has(pluginId) ? "config" : "bundled",
      );
    }
  }
  return origins;
}

function addCoveragePluginLoadPath(config: OpenClawConfig, pluginId: string): void {
  const loadPath = COVERAGE_CONFIG_PLUGIN_SOURCE_DIRS.get(pluginId);
  if (!loadPath) {
    return;
  }
  const existing = getPath(config, ["plugins", "load", "paths"]);
  if (Array.isArray(existing) && existing.includes(loadPath)) {
    return;
  }
  const nextIndex = Array.isArray(existing) ? existing.length : 0;
  setPathCreateStrict(config, ["plugins", "load", "paths", String(nextIndex)], loadPath);
}

function resolveCoverageLoadablePluginOrigins(
  entries: readonly SecretRegistryEntry[],
): ReadonlyMap<string, PluginOrigin> | undefined {
  const origins = new Map<string, PluginOrigin>();
  for (const entry of entries) {
    if (!entry.id.startsWith("plugins.entries.")) {
      continue;
    }
    const pluginId = entry.id.split(".")[2];
    const origin = pluginId ? COVERAGE_LOADABLE_PLUGIN_ORIGINS.get(pluginId) : undefined;
    if (pluginId && origin) {
      origins.set(pluginId, origin);
    }
  }
  return origins.size > 0 ? origins : undefined;
}

function resolveCoverageBatchKey(entry: SecretRegistryEntry): string {
  if (entry.id.startsWith("agents.defaults.")) {
    return entry.id;
  }
  if (entry.id.startsWith("agents.list[].")) {
    return entry.id;
  }
  if (entry.id.startsWith("gateway.auth.")) {
    return entry.id;
  }
  if (entry.id.startsWith("gateway.remote.")) {
    return entry.id;
  }
  if (entry.id.startsWith("models.providers.*.request.auth.")) {
    return entry.id;
  }
  if (entry.id.startsWith("channels.")) {
    const segments = entry.id.split(".");
    const channelId = segments[1] ?? "unknown";
    const field = segments.at(-1);
    if (
      field === "accessToken" ||
      field === "password" ||
      (channelId === "slack" &&
        (field === "appToken" ||
          field === "botToken" ||
          field === "signingSecret" ||
          field === "userToken"))
    ) {
      return entry.id;
    }
    const scope = segments[2] === "accounts" ? "accounts" : "root";
    return `channels.${channelId}.${scope}`;
  }
  if (entry.id.startsWith("messages.tts.providers.")) {
    return "messages.tts.providers";
  }
  if (entry.id.startsWith("models.providers.")) {
    return "models.providers";
  }
  if (entry.id.startsWith("plugins.entries.")) {
    return entry.id;
  }
  if (entry.id.startsWith("skills.entries.")) {
    return "skills.entries";
  }
  if (entry.id.startsWith("talk.providers.")) {
    return "talk.providers";
  }
  if (entry.id.startsWith("talk.")) {
    return "talk";
  }
  return entry.id;
}

function buildCoverageBatches(entries: readonly SecretRegistryEntry[]): SecretRegistryEntry[][] {
  const batches = new Map<string, SecretRegistryEntry[]>();
  for (const entry of entries) {
    const batchKey = resolveCoverageBatchKey(entry);
    const batch = batches.get(batchKey);
    if (batch) {
      batch.push(entry);
      continue;
    }
    batches.set(batchKey, [entry]);
  }
  return [...batches.values()];
}

function logCoverageBatch(label: string, batch: readonly SecretRegistryEntry[]): void {
  if (!DEBUG_COVERAGE_BATCHES || batch.length === 0) {
    return;
  }
  process.stderr.write(
    `[runtime.coverage] ${label} batch (${batch.length}): ${batch.map((entry) => entry.id).join(", ")}\n`,
  );
}

function batchNeedsRuntimeWebTools(batch: readonly SecretRegistryEntry[]): boolean {
  return batch.some(
    (entry) =>
      entry.id.startsWith("tools.web.") ||
      (entry.id.startsWith("plugins.entries.") &&
        (entry.id.includes(".config.webSearch.") || entry.id.includes(".config.webFetch."))),
  );
}

function batchUsesRuntimeWebToolsOnly(batch: readonly SecretRegistryEntry[]): boolean {
  return (
    batch.length > 0 &&
    batch.every(
      (entry) =>
        entry.id.startsWith("tools.web.") ||
        (entry.id.startsWith("plugins.entries.") &&
          (entry.id.includes(".config.webSearch.") || entry.id.includes(".config.webFetch."))),
    )
  );
}

function collectOpenClawCoverageEntries(options: {
  includePluginEntries: boolean;
}): SecretRegistryEntry[] {
  return COVERAGE_REGISTRY_ENTRIES.filter(
    (entry) =>
      entry.configFile === "openclaw.json" &&
      entry.id.startsWith("plugins.entries.") === options.includePluginEntries &&
      !PLUGIN_OWNED_OPENCLAW_COVERAGE_EXCLUSIONS.has(entry.id),
  );
}

function applyConfigForOpenClawTarget(
  config: OpenClawConfig,
  entry: SecretRegistryEntry,
  envId: string,
  wildcardToken: string,
): void {
  const resolvedEnvId = resolveCoverageEnvId(entry, envId);
  const refTargetPath =
    entry.secretShape === "sibling_ref" && entry.refPathPattern // pragma: allowlist secret
      ? entry.refPathPattern
      : entry.pathPattern;
  setPathCreateStrict(config, toConcretePathSegments(refTargetPath, wildcardToken), {
    source: "env",
    provider: "default",
    id: resolvedEnvId,
  });
  if (entry.id.startsWith("models.providers.")) {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "baseUrl"],
      "https://api.example/v1",
    );
    setPathCreateStrict(config, ["models", "providers", wildcardToken, "models"], []);
  }
  if (entry.id.startsWith("plugins.entries.")) {
    const pluginId = entry.id.split(".")[2];
    if (pluginId) {
      setPathCreateStrict(config, ["plugins", "entries", pluginId, "enabled"], true);
      addCoveragePluginLoadPath(config, pluginId);
    }
  }
  if (entry.id === "agents.defaults.memorySearch.remote.apiKey") {
    setPathCreateStrict(config, ["agents", "list", "0", "id"], "sample-agent");
  }
  if (entry.id === "gateway.auth.password") {
    setPathCreateStrict(config, ["gateway", "auth", "mode"], "password");
  }
  if (entry.id === "gateway.remote.token" || entry.id === "gateway.remote.password") {
    setPathCreateStrict(config, ["gateway", "mode"], "remote");
    setPathCreateStrict(config, ["gateway", "remote", "url"], "wss://gateway.example");
  }
  if (entry.id === "channels.telegram.webhookSecret") {
    setPathCreateStrict(config, ["channels", "telegram", "webhookUrl"], "https://example.com/hook");
  }
  if (entry.id === "channels.telegram.accounts.*.webhookSecret") {
    setPathCreateStrict(
      config,
      ["channels", "telegram", "accounts", wildcardToken, "webhookUrl"],
      "https://example.com/hook",
    );
  }
  if (entry.id === "channels.slack.signingSecret") {
    setPathCreateStrict(config, ["channels", "slack", "mode"], "http");
  }
  if (entry.id === "channels.slack.accounts.*.signingSecret") {
    setPathCreateStrict(config, ["channels", "slack", "accounts", wildcardToken, "mode"], "http");
  }
  if (entry.id === "channels.slack.relay.authToken") {
    setPathCreateStrict(config, ["channels", "slack", "mode"], "relay");
  }
  if (entry.id === "channels.slack.accounts.*.relay.authToken") {
    setPathCreateStrict(config, ["channels", "slack", "accounts", wildcardToken, "mode"], "relay");
  }
  if (entry.id === "channels.zalo.webhookSecret") {
    setPathCreateStrict(config, ["channels", "zalo", "webhookUrl"], "https://example.com/hook");
  }
  if (entry.id === "channels.zalo.accounts.*.webhookSecret") {
    setPathCreateStrict(
      config,
      ["channels", "zalo", "accounts", wildcardToken, "webhookUrl"],
      "https://example.com/hook",
    );
  }
  if (entry.id === "channels.qqbot.clientSecret") {
    setPathCreateStrict(config, ["channels", "qqbot", "appId"], "sample-app-id");
  }
  if (entry.id === "channels.qqbot.accounts.*.clientSecret") {
    setPathCreateStrict(
      config,
      ["channels", "qqbot", "accounts", wildcardToken, "appId"],
      "sample-app-id",
    );
  }
  if (entry.id === "channels.feishu.verificationToken") {
    setPathCreateStrict(config, ["channels", "feishu", "connectionMode"], "webhook");
  }
  if (entry.id === "channels.feishu.encryptKey") {
    setPathCreateStrict(config, ["channels", "feishu", "connectionMode"], "webhook");
  }
  if (entry.id === "channels.feishu.accounts.*.verificationToken") {
    setPathCreateStrict(
      config,
      ["channels", "feishu", "accounts", wildcardToken, "connectionMode"],
      "webhook",
    );
  }
  if (entry.id === "channels.feishu.accounts.*.encryptKey") {
    setPathCreateStrict(
      config,
      ["channels", "feishu", "accounts", wildcardToken, "connectionMode"],
      "webhook",
    );
  }
  if (entry.id === "plugins.entries.brave.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "brave");
  }
  if (entry.id === "plugins.entries.google.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "gemini");
  }
  if (entry.id === "plugins.entries.parallel.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "parallel");
  }
  if (entry.id === "plugins.entries.xai.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "grok");
  }
  if (entry.id === "plugins.entries.moonshot.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "kimi");
  }
  if (entry.id === "plugins.entries.perplexity.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "perplexity");
  }
  if (entry.id === "plugins.entries.firecrawl.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "firecrawl");
  }
  if (entry.id === "plugins.entries.minimax.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "minimax");
  }
  if (entry.id === "plugins.entries.parallel.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "parallel");
  }
  if (entry.id === "plugins.entries.tavily.config.webSearch.apiKey") {
    setPathCreateStrict(config, ["tools", "web", "search", "provider"], "tavily");
  }
  if (entry.id === "models.providers.*.request.auth.token") {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "auth", "mode"],
      "authorization-bearer",
    );
  }
  if (entry.id === "models.providers.*.request.auth.value") {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "auth", "mode"],
      "header",
    );
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "auth", "headerName"],
      "x-api-key",
    );
  }
  if (entry.id.startsWith("models.providers.*.request.proxy.tls.")) {
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "proxy", "mode"],
      "explicit-proxy",
    );
    setPathCreateStrict(
      config,
      ["models", "providers", wildcardToken, "request", "proxy", "url"],
      "http://proxy.example:8080",
    );
  }
}

function applyAuthStoreTarget(
  store: AuthProfileStore,
  entry: SecretRegistryEntry,
  envId: string,
  wildcardToken: string,
): void {
  if (entry.authProfileType === "token") {
    setPathCreateStrict(store, ["profiles", wildcardToken], {
      type: "token" as const,
      provider: "sample-provider",
      token: "legacy-token",
      tokenRef: {
        source: "env" as const,
        provider: "default",
        id: envId,
      },
    });
    return;
  }
  setPathCreateStrict(store, ["profiles", wildcardToken], {
    type: "api_key" as const,
    provider: "sample-provider",
    key: "legacy-key",
    keyRef: {
      source: "env" as const,
      provider: "default",
      id: envId,
    },
  });
}

async function prepareConfigCoverageSnapshot(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
  includeRuntimeWebTools?: boolean;
  skipConfigCollectors?: boolean;
}) {
  await ensureConfigCoverageRuntimeLoaded();
  const sourceConfig = params.config;
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: params.env,
  });

  if (!params.skipConfigCollectors) {
    collectConfigAssignments({
      config: resolvedConfig,
      context,
      loadablePluginOrigins: params.loadablePluginOrigins,
    });
  }

  if (context.assignments.length > 0) {
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  if (params.includeRuntimeWebTools) {
    await ensureRuntimeWebToolsLoaded();
    await resolveRuntimeWebTools({
      sourceConfig,
      resolvedConfig,
      context,
    });
  }

  return {
    config: resolvedConfig,
    warnings: context.warnings,
  };
}

async function prepareAuthCoverageSnapshot(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDirs: string[];
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
}) {
  await ensureAuthCoverageRuntimeLoaded();
  const sourceConfig = params.config;
  const context = createResolverContext({
    sourceConfig,
    env: params.env,
  });

  const authStores = params.agentDirs.map((agentDir) => {
    const store = structuredClone(params.loadAuthStore(agentDir));
    collectAuthStoreAssignments({
      store,
      context,
      agentDir,
    });
    return { agentDir, store };
  });

  if (context.assignments.length > 0) {
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  return {
    authStores,
    warnings: context.warnings,
  };
}

async function expectOpenClawCoverageBatchResolved(
  label: string,
  batch: readonly SecretRegistryEntry[],
): Promise<void> {
  logCoverageBatch(label, batch);
  const config = {} as OpenClawConfig;
  const env: Record<string, string> = {};
  for (const [index, entry] of batch.entries()) {
    const envId = toCoverageEnvRefId("OPENCLAW_SECRET_TARGET", entry.id);
    const runtimeEnvId = resolveCoverageEnvId(entry, envId);
    const expectedValue = `resolved-${entry.id}`;
    const wildcardToken = resolveCoverageWildcardToken(index);
    env[runtimeEnvId] = expectedValue;
    applyConfigForOpenClawTarget(config, entry, envId, wildcardToken);
  }
  const snapshot = await prepareConfigCoverageSnapshot({
    config,
    env,
    loadablePluginOrigins: resolveCoverageLoadablePluginOrigins(batch),
    includeRuntimeWebTools: batchNeedsRuntimeWebTools(batch),
    skipConfigCollectors: batchUsesRuntimeWebToolsOnly(batch),
  });
  for (const [index, entry] of batch.entries()) {
    const resolved = getPath(
      snapshot.config,
      resolveCoverageResolvedSegments(entry, resolveCoverageWildcardToken(index)),
    );
    expect(resolved).toBe(`resolved-${entry.id}`);
  }
}

const OPENCLAW_CORE_COVERAGE_BATCHES = buildCoverageBatches(
  collectOpenClawCoverageEntries({ includePluginEntries: false }),
);
const OPENCLAW_PLUGIN_COVERAGE_BATCHES = buildCoverageBatches(
  collectOpenClawCoverageEntries({ includePluginEntries: true }),
);
const AUTH_PROFILE_COVERAGE_BATCHES = buildCoverageBatches(
  COVERAGE_REGISTRY_ENTRIES.filter((entry) => entry.configFile === "auth-profiles.json"),
);

function toCoverageBatchCase(batch: SecretRegistryEntry[]) {
  const firstEntry = batch[0];
  return {
    name:
      batch.length === 1 && firstEntry
        ? firstEntry.id
        : firstEntry
          ? `${resolveCoverageBatchKey(firstEntry)} (${batch.length})`
          : "empty",
    batch,
  };
}

describe("secrets runtime target coverage", () => {
  beforeAll(async () => {
    const [sharedRuntime, resolver, configCollectors, authCollectors, runtimeWebTools] =
      await Promise.all([
        import("./runtime-shared.js"),
        import("./resolve.js"),
        import("./runtime-config-collectors.js"),
        import("./runtime-auth-collectors.js"),
        import("./runtime-web-tools.js"),
      ]);
    ({ applyResolvedAssignments, createResolverContext } = sharedRuntime);
    ({ resolveSecretRefValues } = resolver);
    ({ collectConfigAssignments } = configCollectors);
    ({ collectAuthStoreAssignments } = authCollectors);
    ({ resolveRuntimeWebTools } = runtimeWebTools);

    const googleChatBatch = OPENCLAW_CORE_COVERAGE_BATCHES.find((batch) =>
      batch.some((entry) => entry.id === "channels.googlechat.serviceAccount"),
    );
    if (googleChatBatch) {
      await expectOpenClawCoverageBatchResolved("openclaw.json core", googleChatBatch);
    }
    const webProviderBatch = OPENCLAW_PLUGIN_COVERAGE_BATCHES.find((batch) =>
      batch.some((entry) => entry.id.includes(".config.webSearch.")),
    );
    if (webProviderBatch) {
      // Warm the shared plugin snapshot once; individual target assertions then
      // measure resolution work instead of one-time manifest discovery.
      await expectOpenClawCoverageBatchResolved("openclaw.json plugins", webProviderBatch);
    }
  });

  describe("openclaw.json core and channel registry targets", () => {
    test.each(OPENCLAW_CORE_COVERAGE_BATCHES.map(toCoverageBatchCase))(
      "handles $name",
      async ({ batch }) => {
        await expectOpenClawCoverageBatchResolved("openclaw.json core", batch);
      },
      RUNTIME_COVERAGE_TEST_TIMEOUT_MS,
    );
  });

  describe("openclaw.json plugin registry targets", () => {
    test.each(OPENCLAW_PLUGIN_COVERAGE_BATCHES.map(toCoverageBatchCase))(
      "handles $name",
      async ({ batch }) => {
        await expectOpenClawCoverageBatchResolved("openclaw.json plugins", batch);
      },
      RUNTIME_COVERAGE_TEST_TIMEOUT_MS,
    );
  });

  describe("auth-profiles registry targets", () => {
    test.each(AUTH_PROFILE_COVERAGE_BATCHES.map(toCoverageBatchCase))(
      "handles $name",
      async ({ batch }) => {
        logCoverageBatch("auth-profiles.json", batch);
        const env: Record<string, string> = {};
        const authStore: AuthProfileStore = {
          version: 1,
          profiles: {},
        };
        for (const [index, entry] of batch.entries()) {
          const envId = toCoverageEnvRefId("OPENCLAW_AUTH_SECRET_TARGET", entry.id);
          env[envId] = `resolved-${entry.id}`;
          applyAuthStoreTarget(authStore, entry, envId, resolveCoverageWildcardToken(index));
        }
        const snapshot = await prepareAuthCoverageSnapshot({
          config: {} as OpenClawConfig,
          env,
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadAuthStore: () => authStore,
        });
        const resolvedStore = snapshot.authStores[0]?.store;
        if (!resolvedStore) {
          throw new Error("expected resolved auth store snapshot");
        }
        for (const [index, entry] of batch.entries()) {
          const resolved = getPath(
            resolvedStore,
            toConcretePathSegments(entry.pathPattern, resolveCoverageWildcardToken(index)),
          );
          expect(resolved).toBe(`resolved-${entry.id}`);
        }
      },
      RUNTIME_COVERAGE_TEST_TIMEOUT_MS,
    );
  });
});
