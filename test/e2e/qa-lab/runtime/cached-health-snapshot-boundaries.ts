import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { HealthSummary } from "../../../../src/gateway/health/types.js";
import { healthHandlers } from "../../../../src/gateway/server-methods/health.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/cached-health-snapshot-boundaries.ts";
const SCENARIO_PATH = "qa/scenarios/observability/cached-health-snapshot-boundaries.yaml";
const FIXTURE_PLUGIN_ID = "qa-cached-health-tool";
const FIXTURE_TOOL_NAME = "qa_cached_health_echo";
const FIXTURE_RESULT = "QA-CACHED-HEALTH-TOOL-OK";

type HandlerResponse = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
  meta?: Record<string, unknown>;
};

type CachedHealthProof = {
  cacheHitSameTimestamp: boolean;
  cachedMeta: boolean;
  passiveRefreshBounded: boolean;
  staleRefresh: boolean;
  explicitProbeRefresh: boolean;
  lifecycleMismatchRefresh: boolean;
  liveOverlayMerged: boolean;
  publicSensitiveOmitted: boolean;
  pluginLoaded: boolean;
  pluginToolCataloged: boolean;
  pluginToolInvoked: boolean;
  healthAfterTool: boolean;
};

function snapshot(overrides: Partial<HealthSummary> = {}): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "state/sessions", count: 0, recent: [] },
    ...overrides,
  };
}

export async function invokeHealthHandler(params: {
  cached: HealthSummary | null;
  fresh: HealthSummary;
  requestParams?: Record<string, unknown>;
  runtimeSnapshot?: Record<string, unknown>;
  scopes?: string[];
  refresh?: (input: { probe: boolean; includeSensitive: boolean }) => Promise<HealthSummary>;
  eventLoop?: Record<string, unknown>;
}) {
  const responses: HandlerResponse[] = [];
  const refreshCalls: Array<{ probe: boolean; includeSensitive: boolean }> = [];
  const refresh = params.refresh
    ? params.refresh
    : async (input: { probe: boolean; includeSensitive: boolean }) => {
        refreshCalls.push(input);
        return params.fresh;
      };
  const handler = healthHandlers.health;
  if (!handler) {
    throw new Error("health handler is unavailable");
  }
  await handler.call(healthHandlers, {
    req: { type: "req", id: "qa-health", method: "health" },
    params: params.requestParams ?? {},
    respond: (ok: boolean, payload?: unknown, error?: unknown, meta?: Record<string, unknown>) =>
      responses.push({ ok, payload, error, meta }),
    context: {
      getHealthCache: () => params.cached,
      refreshHealthSnapshot: refresh,
      getRuntimeSnapshot: () => params.runtimeSnapshot ?? { channels: {}, channelAccounts: {} },
      getEventLoopHealth: params.eventLoop ? () => params.eventLoop : undefined,
      getConfigReloaderHotReloadStatus: () => "active",
      logHealth: { error: () => undefined },
    },
    client: { connect: { role: "operator", scopes: params.scopes ?? ["operator.read"] } },
    isWebchatConnect: () => false,
  } as never);
  return { responses, refreshCalls };
}

export async function runHandlerBoundaryProof() {
  const cached = snapshot({ ts: Date.now(), eventLoop: { status: "stale" } as never });
  const fresh = snapshot({ ts: cached.ts + 1 });
  const sharedRefreshCalls: Array<{ probe: boolean; includeSensitive: boolean }> = [];
  const sharedRefresh = async (input: { probe: boolean; includeSensitive: boolean }) => {
    sharedRefreshCalls.push(input);
    return fresh;
  };
  const first = await invokeHealthHandler({
    cached,
    fresh,
    refresh: sharedRefresh,
    eventLoop: { status: "live" },
  });
  const second = await invokeHealthHandler({
    cached,
    fresh,
    refresh: sharedRefresh,
    eventLoop: { status: "live" },
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  const stale = await invokeHealthHandler({
    cached: snapshot({ ts: Date.now() - 60_001 }),
    fresh,
  });
  const probe = await invokeHealthHandler({
    cached,
    fresh,
    requestParams: { probe: true },
    scopes: ["operator.read", "operator.admin"],
  });
  const lifecycleCached = snapshot({
    channels: {
      "qa-channel": {
        accountId: "default",
        running: true,
        connected: true,
        accounts: {
          default: { accountId: "default", running: true, connected: true },
        },
      },
    },
    channelOrder: ["qa-channel"],
    channelLabels: { "qa-channel": "QA Channel" },
  });
  const lifecycle = await invokeHealthHandler({
    cached: lifecycleCached,
    fresh,
    runtimeSnapshot: {
      channels: {
        "qa-channel": { accountId: "default", running: false, connected: false },
      },
      channelAccounts: {
        "qa-channel": {
          default: { accountId: "default", running: false, connected: false },
        },
      },
    },
  });
  const publicRefresh = await invokeHealthHandler({
    cached: null,
    fresh,
    scopes: ["operator.read"],
  });

  const firstResponse = first.responses[0];
  const publicRefreshCall = publicRefresh.refreshCalls[0];
  return {
    cacheHitSameTimestamp:
      (firstResponse?.payload as { ts?: unknown } | undefined)?.ts === cached.ts,
    // meta is wire-typed Record<string, unknown>: assert the literal boolean so a
    // truthy non-boolean (e.g. "true") cannot satisfy the cached contract.
    cachedMeta: firstResponse?.meta?.cached === true,
    passiveRefreshBounded:
      sharedRefreshCalls.length === 1 && second.responses[0]?.meta?.cached === true,
    staleRefresh: stale.refreshCalls.length === 1 && stale.responses[0]?.meta === undefined,
    explicitProbeRefresh:
      probe.refreshCalls.length === 1 &&
      (probe.refreshCalls[0]?.probe ?? false) &&
      (probe.refreshCalls[0]?.includeSensitive ?? false),
    lifecycleMismatchRefresh:
      lifecycle.refreshCalls.length === 1 && lifecycle.responses[0]?.meta === undefined,
    liveOverlayMerged:
      (firstResponse?.payload as { eventLoop?: { status?: unknown } } | undefined)?.eventLoop
        ?.status === "live",
    publicSensitiveOmitted: publicRefreshCall !== undefined && !publicRefreshCall.includeSensitive,
  };
}

export async function createFixturePlugin() {
  // openclaw-temp-dir: standalone producer removes this fixture root in its finally block
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cached-health-tool-"));
  const pluginDir = path.join(root, FIXTURE_PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: FIXTURE_PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: { tools: [FIXTURE_TOOL_NAME] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: ${JSON.stringify(FIXTURE_PLUGIN_ID)},
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(FIXTURE_TOOL_NAME)},
      description: "Echo a bounded QA cache marker",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      },
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: ${JSON.stringify(FIXTURE_RESULT)} + ":" + params.value }] };
      }
    });
  }
};
`,
    "utf8",
  );
  return { pluginDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export function withFixturePlugin(config: OpenClawConfig, pluginDir: string): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), FIXTURE_PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        [FIXTURE_PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsString(entry, needle));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => containsString(entry, needle));
  }
  return false;
}

async function runPluginToolProof(repoRoot: string) {
  const fixture = await createFixturePlugin();
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot,
      useRepoCli: true,
      transportBaseUrl: "http://127.0.0.1",
      providerMode: "mock-openai",
      controlUiEnabled: false,
      mutateConfig: (config) => withFixturePlugin(config, fixture.pluginDir),
    });
    const before = (await gateway.call("health", { probe: true })) as HealthSummary;
    const catalog = await gateway.call("tools.catalog", { includePlugins: true });
    const invoked = await gateway.call("tools.invoke", {
      name: FIXTURE_TOOL_NAME,
      sessionKey: "agent:main:qa-cached-health",
      args: { value: "after-health" },
    });
    const after = (await gateway.call("health", { probe: true })) as HealthSummary;
    return {
      pluginLoaded: before.plugins?.loaded.includes(FIXTURE_PLUGIN_ID) ?? false,
      pluginToolCataloged: containsString(catalog, FIXTURE_TOOL_NAME),
      pluginToolInvoked: containsString(invoked, FIXTURE_RESULT),
      healthAfterTool: after.ok && Boolean(after.plugins?.loaded.includes(FIXTURE_PLUGIN_ID)),
    };
  } finally {
    await gateway?.stop().catch(() => undefined);
    await fixture.cleanup();
  }
}

export async function runCachedHealthSnapshotBoundariesProof(
  repoRoot = path.resolve(import.meta.dirname, "../../../.."),
): Promise<CachedHealthProof> {
  return {
    ...(await runHandlerBoundaryProof()),
    ...(await runPluginToolProof(repoRoot)),
  };
}

function parseArtifactBase(argv: readonly string[]) {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

export async function main(argv = process.argv.slice(2)) {
  const artifactBase = parseArtifactBase(argv);
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const writer = createQaScriptEvidenceWriter({
    artifactBase,
    logFileName: "cached-health-snapshot-boundaries.log",
    primaryModel: "none",
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: "cached-health-snapshot-boundaries",
      title: "Cached health snapshot boundaries",
      sourcePath: SCENARIO_PATH,
      docsRefs: ["docs/gateway/health.md", "docs/gateway/protocol.md"],
      codeRefs: [SOURCE_PATH, "src/gateway/server-methods/health.ts"],
    },
  });
  const startedAt = Date.now();
  try {
    const proof = await runCachedHealthSnapshotBoundariesProof(repoRoot);
    const failures = Object.entries(proof)
      .filter(([, passed]) => !passed)
      .map(([name]) => `${name} failed`);
    writer.appendLog(`${JSON.stringify(proof, null, 2)}\n`);
    await writer.write({
      status: failures.length === 0 ? "pass" : "fail",
      durationMs: Date.now() - startedAt,
      details:
        failures.length === 0 ? "cache and plugin-tool boundaries passed" : failures.join("; "),
    });
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  } catch (error) {
    writer.appendLog(`${error instanceof Error ? error.stack : String(error)}\n`);
    await writer.write({
      status: "fail",
      durationMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
