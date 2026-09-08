// Fresh-process fixture: value imports stay outside OpenClaw until each scenario demands them.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";

const PLUGIN_ID = "mcp-proof-owner";
const PROVIDER_ID = "mcp-proof-provider";
const EXTERNAL_PROFILE = `${PROVIDER_ID}:external`;
const STORED_PROFILE = `${PROVIDER_ID}:stored`;
const OBSERVER_KEY: unique symbol = Symbol.for("openclaw.mcpAuthIntegrationObserver");
type HookContext = { config?: OpenClawConfig; agentDir?: string };
type ProviderEvent = { kind: string; owner: string };
type FixtureGlobal = typeof globalThis & {
  [OBSERVER_KEY]?: (kind: string, owner: string, context?: HookContext) => void;
};
const providerEvents: ProviderEvent[] = [];
let inspectHook: ((owner: string, context?: HookContext) => void) | undefined;
let authRuntimeEntered = false;

function observe(kind: string, owner: string, context?: HookContext): void {
  providerEvents.push({ kind, owner });
  if (kind !== "evaluated" && kind !== "registered") {
    inspectHook?.(owner, context);
  }
}

function writeProvider(root: string, owner: string, tokenUrl: string, enabled = true) {
  const pluginDir = path.join(root, "plugins", owner);
  const agentDir = path.join(root, "state", "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspaces", owner);
  for (const dir of [pluginDir, agentDir, workspaceDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const credentialPath = path.join(root, `external-${owner}.txt`);
  fs.writeFileSync(credentialPath, "first");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      contracts: { externalAuthProviders: [PROVIDER_ID] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const source = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(
    source,
    `const fs = require("node:fs");
const observe = (kind, context) => globalThis[Symbol.for("openclaw.mcpAuthIntegrationObserver")](kind, ${JSON.stringify(owner)}, context);
observe("evaluated");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    observe("registered");
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)},
      label: "MCP proof provider",
      auth: [],
      resolveExternalAuthProfiles(context) {
        observe("overlay", { config: context.config, agentDir: context.agentDir });
        const file = ${JSON.stringify(credentialPath)};
        if (!fs.existsSync(file)) return [];
        return [{
          profileId: ${JSON.stringify(EXTERNAL_PROFILE)},
          credential: {
            type: "oauth",
            provider: ${JSON.stringify(PROVIDER_ID)},
            accountId: "fixture-account",
            access: ${JSON.stringify(`${owner}:`)} + fs.readFileSync(file, "utf8"),
            refresh: "external-refresh-not-real",
            expires: Date.now() + 3_600_000,
          },
        }];
      },
      formatApiKey(credential) {
        observe("formatted");
        return JSON.stringify({ token: credential.access, formatterOnly: "must-not-project" });
      },
      async refreshOAuth(credential) {
        observe("refresh");
        const response = await fetch(${JSON.stringify(tokenUrl)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh: credential.refresh }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("fixture refresh denied");
        }
        const rotated = await response.json();
        observe("refreshed");
        return { ...credential, ...rotated };
      },
    });
  },
};
`,
  );
  const config: OpenClawConfig = {
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [source] },
      entries: { [PLUGIN_ID]: { enabled } },
      slots: { memory: "none" },
    },
  };
  return { config, agentDir, workspaceDir, credentialPath };
}

type ProviderFixture = ReturnType<typeof writeProvider>;
type HttpRequest = { method?: string; headers: IncomingHttpHeaders; body: string };

async function createHttpFixture() {
  const requests: HttpRequest[] = [];
  const refreshInputs: string[] = [];
  const order: string[] = [];
  const errors: unknown[] = [];
  const behavior = { rejectRefresh: false };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      if (request.url === "/token") {
        const input = JSON.parse(body) as { refresh: string };
        refreshInputs.push(input.refresh);
        order.push("refresh");
        response.statusCode = behavior.rejectRefresh ? 503 : 200;
        response.end(
          JSON.stringify({
            access: "rotated-access-not-real",
            refresh: "rotated-refresh-not-real",
            expires: Date.now() + 3_600_000,
          }),
        );
        return;
      }
      requests.push({ method: request.method, headers: request.headers, body });
      order.push("mcp");
      const message = body
        ? (JSON.parse(body) as {
            id?: number;
            method?: string;
            params?: { protocolVersion: string };
          })
        : undefined;
      // This JSON-only endpoint declines the SDK's optional SSE stream.
      if (request.method === "GET" && request.headers.accept === "text/event-stream") {
        response.statusCode = 405;
        response.setHeader("allow", "POST");
        response.end();
        return;
      }
      if (message?.method && message.id === undefined) {
        response.statusCode = 202;
        response.end();
        return;
      }
      const result =
        message?.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: {},
              serverInfo: { name: "mcp-proof", version: "1.0.0" },
            }
          : {};
      response.end(
        JSON.stringify(
          message?.id === undefined ? { ok: true } : { jsonrpc: "2.0", id: message.id, result },
        ),
      );
    })().catch((error: unknown) => {
      errors.push(error);
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    tokenUrl: `${origin}/token`,
    requests,
    refreshInputs,
    order,
    behavior,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      assert.deepEqual(errors, []);
    },
  };
}

async function consumeFetch(fetchFn: FetchLike, url: string | URL, init?: RequestInit) {
  const response = await fetchFn(url, init);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
}

function bundleConfig(url: string, profileId = STORED_PROFILE) {
  return {
    mcpServers: {
      proof: {
        url,
        auth: "oauth",
        oauth: { authProfileId: profileId },
        headers: { Authorization: "Bearer stale-config-not-real", "X-Trace": "keep" },
      },
    },
  };
}

function isCredentialModule(value: string): boolean {
  return /(?:^|\/)(?:auth-profiles\/(?:oauth|store)|mcp-auth-profile\.runtime)\.[cm]?[jt]s(?:$|[?#])/u.test(
    value.replaceAll("\\", "/"),
  );
}

async function runExternalScenario(root: string): Promise<void> {
  const endpoint = await createHttpFixture();
  const foreign = await createHttpFixture();
  const fixture = writeProvider(root, "external", endpoint.tokenUrl);
  const moduleAttempts: string[] = [];
  const moduleLoads: string[] = [];
  const observeModuleAttempt = (specifier: string) => {
    if (isCredentialModule(specifier)) {
      moduleAttempts.push(specifier);
      assert(
        authRuntimeEntered,
        `credential module requested before MCP bearer demand: ${specifier}`,
      );
    }
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      observeModuleAttempt(specifier);
      const resolved = nextResolve(specifier, context);
      if (!isCredentialModule(specifier)) {
        observeModuleAttempt(resolved.url);
      }
      return resolved;
    },
    load(url, context, nextLoad) {
      // Source loading is not evaluation; the real plugin records evaluation separately.
      const loaded = nextLoad(url, context);
      if (isCredentialModule(url)) {
        moduleLoads.push(url);
      }
      return loaded;
    },
  });
  try {
    const { resolveMcpBearerBundleConfig, withMcpAuthProfileBearer } =
      await import("./mcp-auth-profile.js");
    const calls: Array<{ url: string | URL; init?: RequestInit }> = [];
    const wrapped = withMcpAuthProfileBearer({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return fetch(url, init);
      },
      serverName: "proof",
      resourceUrl: endpoint.url,
      authProfileId: EXTERNAL_PROFILE,
      cfg: fixture.config,
      agentDir: fixture.agentDir,
      headers: { Authorization: "Bearer stale-config-not-real", "X-Trace": "keep" },
    });
    const plain = { mcpServers: { plain: { url: endpoint.url } } };
    assert.deepEqual(await resolveMcpBearerBundleConfig({ config: plain }), {
      config: plain,
      env: undefined,
    });
    const foreignInit = { headers: { Authorization: "Bearer caller-owned-not-real" } };
    await consumeFetch(wrapped, foreign.url, foreignInit);
    assert.equal(calls[0]?.init, foreignInit);
    // Assert a completed phase, not the live recorders the next request populates.
    const beforeDemand = {
      moduleAttempts: [...moduleAttempts],
      moduleLoads: [...moduleLoads],
      providerEvents: [...providerEvents],
    };
    assert.deepEqual(beforeDemand, { moduleAttempts: [], moduleLoads: [], providerEvents: [] });

    authRuntimeEntered = true;
    const signal = new AbortController().signal;
    await consumeFetch(wrapped, new URL(endpoint.url), {
      headers: { Authorization: "Bearer stale-request-not-real", Accept: "application/json" },
      signal,
    });
    assert.equal(calls.at(-1)?.init?.signal, signal);
    assert.equal(endpoint.requests.at(-1)?.headers.authorization, "Bearer external:first");
    assert.equal(endpoint.requests.at(-1)?.headers["x-trace"], "keep");
    assert.equal(endpoint.requests.at(-1)?.headers.accept, "application/json");
    assert(moduleAttempts.some((entry) => entry.includes("auth-profiles")));
    assert(moduleLoads.some((entry) => entry.includes("auth-profiles")));
    for (const kind of ["evaluated", "registered", "overlay", "formatted"]) {
      assert(
        providerEvents.some((event) => event.kind === kind),
        `missing provider event: ${kind}`,
      );
    }

    fs.writeFileSync(fixture.credentialPath, "rotated");
    await consumeFetch(wrapped, endpoint.url);
    assert.equal(endpoint.requests.at(-1)?.headers.authorization, "Bearer external:rotated");
    fs.rmSync(fixture.credentialPath);
    const sent = endpoint.requests.length;
    await assert.rejects(() => wrapped(endpoint.url), /profile was not found/u);
    assert.equal(endpoint.requests.length, sent);
    const eventsAfterRemoval = providerEvents.length;
    await consumeFetch(wrapped, new URL(foreign.url), foreignInit);
    assert.equal(calls.at(-1)?.init, foreignInit);
    assert.equal(providerEvents.length, eventsAfterRemoval);
    for (const request of foreign.requests) {
      assert.equal(request.headers.authorization, "Bearer caller-owned-not-real");
      assert.equal(request.headers["x-trace"], undefined);
    }
    const { loadPersistedAuthProfileStore } = await import("./auth-profiles/persisted.js");
    assert.equal(
      loadPersistedAuthProfileStore(fixture.agentDir)?.profiles[EXTERNAL_PROFILE],
      undefined,
    );
    console.log(JSON.stringify({ moduleAttempts, moduleLoads, providerEvents }));
  } finally {
    hooks.deregister();
    await Promise.all([endpoint.close(), foreign.close()]);
  }
}

async function runRefreshScenario(root: string): Promise<void> {
  authRuntimeEntered = true;
  const { filterStringRecord } = await import("@openclaw/normalization-core/record-coerce");
  const { saveAuthProfileStore } = await import("./auth-profiles/store-runtime.js");
  const { loadPersistedAuthProfileStore } = await import("./auth-profiles/persisted.js");
  const { resolveMcpBearerBundleConfig, withMcpAuthProfileBearer } =
    await import("./mcp-auth-profile.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const endpoint = await createHttpFixture();
  const fixture = writeProvider(root, "refresh", endpoint.tokenUrl);
  const expired: OAuthCredential = {
    type: "oauth",
    provider: PROVIDER_ID,
    accountId: "fixture-account",
    access: "expired-access-not-real",
    refresh: "stored-refresh-not-real",
    expires: 1,
  };
  const seed = () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [STORED_PROFILE]: expired,
        [`${PROVIDER_ID}:static`]: {
          type: "token",
          provider: PROVIDER_ID,
          token: "static-not-real",
        },
      },
    };
    saveAuthProfileStore(store, fixture.agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  };
  seed();
  const wrapped = withMcpAuthProfileBearer({
    fetchFn: fetch,
    serverName: "proof",
    resourceUrl: endpoint.url,
    authProfileId: STORED_PROFILE,
    cfg: fixture.config,
    agentDir: fixture.agentDir,
    headers: { "X-Trace": "keep", Authorization: "Bearer stale-config-not-real" },
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    fetch: wrapped,
    requestInit: { headers: { "X-Request": "keep", Authorization: "Bearer stale-sdk-not-real" } },
  });
  const client = new Client({ name: "mcp-auth-proof", version: "1.0.0" });
  // Optional SSE GETs are independent of the ordered RPC POSTs under test.
  const mcpPosts = () => endpoint.requests.filter((request) => request.method === "POST");
  try {
    await client.connect(transport);
    assert.deepEqual(await client.ping(), {});
    assert.deepEqual(await client.ping(), {});
    assert.deepEqual(endpoint.refreshInputs, ["stored-refresh-not-real"]);
    assert.equal(endpoint.order[0], "refresh");
    assert.deepEqual(
      mcpPosts().map((request) => (JSON.parse(request.body) as { method: string }).method),
      ["initialize", "notifications/initialized", "ping", "ping"],
    );
    for (const request of endpoint.requests) {
      assert.equal(request.headers.authorization, "Bearer rotated-access-not-real");
      assert.equal(request.headers["x-trace"], "keep");
      assert.equal(request.headers["x-request"], "keep");
      assert.equal(
        request.headers.accept,
        request.method === "POST" ? "application/json, text/event-stream" : "text/event-stream",
      );
    }
    const stored = loadPersistedAuthProfileStore(fixture.agentDir)?.profiles[STORED_PROFILE];
    assert(stored?.type === "oauth");
    assert.equal(stored.access, "rotated-access-not-real");
    assert.equal(stored.refresh, "rotated-refresh-not-real");
    assert.equal(stored.accountId, "fixture-account");

    for (const tokenProjection of ["env", "literal"] as const) {
      const projected = await resolveMcpBearerBundleConfig({
        config: bundleConfig(endpoint.url),
        cfg: fixture.config,
        agentDir: fixture.agentDir,
        tokenProjection,
      });
      const server = projected.config.mcpServers.proof;
      assert(server);
      const headers = filterStringRecord(server.headers);
      const authorization = headers?.Authorization;
      assert.equal(typeof authorization, "string");
      if (tokenProjection === "literal") {
        assert.equal(authorization, "Bearer rotated-access-not-real");
        assert.equal(projected.env, undefined);
      } else {
        const envKey = /^Bearer \$\{([^}]+)\}$/u.exec(String(authorization))?.[1];
        assert(envKey);
        assert.equal(projected.env?.[envKey], "rotated-access-not-real");
      }
      assert.equal(headers?.["X-Trace"], "keep");
      assert.equal(server.auth, undefined);
      assert.equal(server.oauth, undefined);
      const serialized = JSON.stringify(projected);
      assert(!serialized.includes("rotated-refresh-not-real"));
      assert(!serialized.includes("formatterOnly"));
    }
    for (const [profileId, error] of [
      [`${PROVIDER_ID}:missing`, /profile was not found/u],
      [`${PROVIDER_ID}:static`, /profiles are not refreshable/u],
    ] as const) {
      await assert.rejects(
        () =>
          resolveMcpBearerBundleConfig({
            config: bundleConfig(endpoint.url, profileId),
            cfg: fixture.config,
            agentDir: fixture.agentDir,
          }),
        error,
      );
    }
    seed();
    endpoint.behavior.rejectRefresh = true;
    const sent = mcpPosts().length;
    await assert.rejects(
      () => client.ping(),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /fixture refresh denied/u);
        assert(!error.message.includes(expired.access));
        assert(!error.message.includes(expired.refresh));
        return true;
      },
    );
    assert.equal(mcpPosts().length, sent);
    assert(providerEvents.some((event) => event.kind === "refresh"));
    assert(providerEvents.some((event) => event.kind === "refreshed"));
  } finally {
    await client.close();
    await endpoint.close();
  }
}

async function runScopeScenario(root: string): Promise<void> {
  authRuntimeEntered = true;
  const { createPluginCache, withPluginCache } = await import("../plugins/plugin-cache.js");
  const { loadPluginMetadataSnapshot } = await import("../plugins/plugin-metadata-snapshot.js");
  const { loadPluginRegistryHandle } = await import("../plugins/loader.js");
  const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
  const { getPluginRegistryState } = await import("../plugins/runtime-state.js");
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  const { getPluginRuntimeGenerationRegistry, withPluginRuntimeGenerationScope } =
    await import("../plugins/runtime/generation-scope.js");
  const { getPluginRuntimeGatewayRequestScope, withPluginRuntimeGatewayRequestScope } =
    await import("../plugins/runtime/gateway-request-scope.js");
  const { withMcpAuthProfileBearer } = await import("./mcp-auth-profile.js");
  const prepare = (fixture: ProviderFixture) =>
    withPluginCache(createPluginCache(), () => {
      const metadataSnapshot = loadPluginMetadataSnapshot({
        config: fixture.config,
        env: process.env,
        workspaceDir: fixture.workspaceDir,
        preferPersisted: false,
      });
      const pluginRegistry = loadPluginRegistryHandle({
        config: fixture.config,
        env: process.env,
        workspaceDir: fixture.workspaceDir,
        manifestRegistry: metadataSnapshot.manifestRegistry,
        installRecords: {},
        onlyPluginIds: [PLUGIN_ID],
        cache: false,
      });
      return { config: fixture.config, metadataSnapshot, pluginRegistry };
    });
  const endpoint = await createHttpFixture();
  try {
    const fixtures = ["first", "second", "disabled"].map((owner) =>
      writeProvider(root, owner, endpoint.tokenUrl, owner !== "disabled"),
    );
    const owners = fixtures.map((fixture, index) => {
      const generation = prepare(fixture);
      const request = {
        pluginId: `requester-${index}`,
        isWebchatConnect: () => false,
        resolveGatewayContext: () => undefined,
      };
      return { fixture, generation, request };
    });
    type ScopedOwner = (typeof owners)[number];
    const [first, second, disabled] = owners;
    assert(first && second && disabled);
    assert.equal(first.generation.pluginRegistry.providers.length, 1);
    assert.equal(second.generation.pluginRegistry.providers.length, 1);
    assert.equal(disabled.generation.pluginRegistry.providers.length, 0);
    const checkScope = (owner: ScopedOwner, context?: HookContext) => {
      const scope = getPluginRuntimeGatewayRequestScope();
      assert(scope, "request scope must survive deferred auth");
      assert.equal(scope.pluginId, owner.request.pluginId);
      assert.equal(scope.isWebchatConnect === owner.request.isWebchatConnect, true);
      assert.equal(scope.resolveGatewayContext === owner.request.resolveGatewayContext, true);
      assert.equal(scope.pluginRegistry === owner.generation.pluginRegistry, true);
      assert.equal(
        scope.declaredProviderOwners === owner.generation.metadataSnapshot.declaredProviderOwners,
        true,
      );
      assert.equal(getPluginRuntimeGenerationRegistry() === owner.generation.pluginRegistry, true);
      if (context) {
        assert.equal(context.config, owner.fixture.config);
        assert.equal(context.agentDir, owner.fixture.agentDir);
      }
    };
    inspectHook = (name, context) => checkScope(name === "first" ? first : second, context);
    const bind = (owner: ScopedOwner) => {
      const wrapped = withMcpAuthProfileBearer({
        fetchFn: async (url, init) => {
          checkScope(owner);
          return fetch(url, init);
        },
        serverName: "proof",
        resourceUrl: endpoint.url,
        authProfileId: EXTERNAL_PROFILE,
        cfg: owner.fixture.config,
        agentDir: owner.fixture.agentDir,
      });
      return () =>
        withPluginRuntimeGatewayRequestScope(owner.request, () =>
          withPluginRuntimeGenerationScope(owner.generation, () =>
            consumeFetch(wrapped, endpoint.url),
          ),
        );
    };
    const firstRequest = bind(first);
    const secondRequest = bind(second);
    setActivePluginRegistry(createEmptyPluginRegistry(), "empty-root");
    const pendingFirst = firstRequest();
    setActivePluginRegistry(
      second.generation.pluginRegistry,
      "replacement-root",
      "default",
      second.fixture.workspaceDir,
    );
    await Promise.all([pendingFirst, secondRequest()]);
    const authorizations = endpoint.requests.map((request) => {
      const authorization = request.headers.authorization;
      assert(authorization, "missing Authorization header on a scoped MCP request");
      return authorization;
    });
    assert.deepEqual(
      authorizations.toSorted((left, right) => left.localeCompare(right)),
      ["Bearer first:first", "Bearer second:first"],
    );
    fs.writeFileSync(first.fixture.credentialPath, "rotated");
    await firstRequest();
    assert.equal(endpoint.requests.at(-1)?.headers.authorization, "Bearer first:rotated");
    const sent = endpoint.requests.length;
    await assert.rejects(bind(disabled), /profile was not found/u);
    assert.equal(endpoint.requests.length, sent);
    assert(!providerEvents.some((event) => event.owner === "disabled"));
    assert.equal(getPluginRuntimeGatewayRequestScope(), undefined);
    assert.equal(getPluginRuntimeGenerationRegistry(), undefined);
    assert.equal(
      getPluginRegistryState()?.activeRegistry === second.generation.pluginRegistry,
      true,
    );
  } finally {
    inspectHook = undefined;
    await endpoint.close();
  }
}

async function main(): Promise<void> {
  const [scenario, root] = process.argv.slice(2);
  assert(root);
  const globals = globalThis as FixtureGlobal;
  globals[OBSERVER_KEY] = observe;
  try {
    switch (scenario) {
      case "external":
        await runExternalScenario(root);
        break;
      case "refresh":
        await runRefreshScenario(root);
        break;
      case "scopes":
        await runScopeScenario(root);
        break;
      default:
        throw new Error(`Unknown MCP auth proof scenario: ${scenario}`);
    }
  } finally {
    try {
      // A rejected cold import must not load auth owners merely to clean them up.
      if (authRuntimeEntered) {
        const { closeAuthProfileReadPool } = await import("./auth-profiles/sqlite.js");
        const { closeOpenClawAgentDatabasesForTest } =
          await import("../state/openclaw-agent-db.js");
        const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
        closeAuthProfileReadPool();
        // Agent closure releases leases through shared state; close that owner last.
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    } finally {
      delete globals[OBSERVER_KEY];
    }
  }
  console.log(`MCP_AUTH_PROOF_OK ${scenario}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
