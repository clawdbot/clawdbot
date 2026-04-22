import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginOrigin } from "../plugins/types.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import { canonicalizeSecretTargetCoverageId } from "./target-registry-test-helpers.js";

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
const COVERAGE_LOADABLE_PLUGIN_ORIGINS =
  buildCoverageLoadablePluginOrigins(COVERAGE_REGISTRY_ENTRIES);
const PLUGIN_OWNED_OPENCLAW_COVERAGE_EXCLUSIONS = new Set([
  "channels.googlechat.accounts.*.serviceAccount",
  // Doctor migrates legacy web search config into plugin-owned webSearch config.
  "tools.web.search.apiKey",
  "tools.web.fetch.firecrawl.apiKey",
]);

let applyResolvedAssignments: typeof import("./runtime-shared.js").applyResolvedAssignments;
let collectAuthStoreAssignments: typeof import("./runtime-auth-collectors.js").collectAuthStoreAssignments;
let collectConfigAssignments: typeof import("./runtime-config-collectors.js").collectConfigAssignments;
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveSecretRefValues: typeof import("./resolve.js").resolveSecretRefValues;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;

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
  const segments = pathPattern.split(".").filter(Boolean);
  const out: string[] = [];
  for (const segment of segments) {
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
      origins.set(pluginId, "bundled");
    }
  }
  return origins;
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

describe("secrets runtime target coverage", () => {
  beforeAll(async () => {
    const [sharedRuntime, resolver] = await Promise.all([
      import("./runtime-shared.js"),
      import("./resolve.js"),
    ]);
    ({ applyResolvedAssignments, createResolverContext } = sharedRuntime);
    ({ resolveSecretRefValues } = resolver);
  });

  it("handles every openclaw.json registry target when configured as active", async () => {
    const entries = COVERAGE_REGISTRY_ENTRIES.filter(
      (entry) =>
        entry.configFile === "openclaw.json" &&
        !PLUGIN_OWNED_OPENCLAW_COVERAGE_EXCLUSIONS.has(entry.id),
    );
    for (const batch of buildCoverageBatches(entries)) {
      logCoverageBatch("openclaw.json", batch);
      const config = {} as OpenClawConfig;
      const env: Record<string, string> = {};
      for (const [index, entry] of batch.entries()) {
        const envId = `OPENCLAW_SECRET_TARGET_${entry.id}`;
        const runtimeEnvId = resolveCoverageEnvId(entry, envId);
        const expectedValue = `resolved-${entry.id}`;
        const wildcardToken = resolveCoverageWildcardToken(index);
        env[runtimeEnvId] = expectedValue;
        applyConfigForOpenClawTarget(config, entry, envId, wildcardToken);
      }
      const snapshot = await prepareConfigCoverageSnapshot({
        config,
        env,
        loadablePluginOrigins: COVERAGE_LOADABLE_PLUGIN_ORIGINS,
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
  });

  it("handles every auth-profiles registry target", async () => {
    const entries = COVERAGE_REGISTRY_ENTRIES.filter(
      (entry) => entry.configFile === "auth-profiles.json",
    );
    for (const batch of buildCoverageBatches(entries)) {
      logCoverageBatch("auth-profiles.json", batch);
      const env: Record<string, string> = {};
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: {},
      };
      for (const [index, entry] of batch.entries()) {
        const envId = `OPENCLAW_AUTH_SECRET_TARGET_${entry.id}`;
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
      expect(resolvedStore).toBeDefined();
      for (const [index, entry] of batch.entries()) {
        const resolved = getPath(
          resolvedStore,
          toConcretePathSegments(entry.pathPattern, resolveCoverageWildcardToken(index)),
        );
        expect(resolved).toBe(`resolved-${entry.id}`);
      }
    }
  });
});
