/** Unit tests for requester-scoped MCP connection resolver helpers. */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { createGatewayCronReconciliation } from "../gateway/server-cron-reconciled.js";
import { createGatewayReloadHandlers } from "../gateway/server-reload-handlers.js";
import {
  isGatewaySigusr1RestartExternallyAllowed,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import {
  disposeAllSessionMcpRuntimes,
  getOrCreateSessionMcpRuntime,
  peekSessionMcpRuntime,
} from "./agent-bundle-mcp-tools.js";
import {
  applyMcpConnectionOverride,
  buildMcpRequesterRuntimeCacheKey,
  hashMcpResolvedConnections,
  partitionMcpServersByConnectionScope,
  redactMcpServersForFingerprint,
  resolveRequesterScopedMcpConnections,
  testing,
} from "./mcp-connection-resolver.js";
import { clearCurrentProviderAuthState } from "./model-provider-auth.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

type AuthenticatedMcpProofEndpoint = {
  owner: string;
  authorization: string;
  path: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  requests: number;
  unauthorizedRequests: number;
  streamedResponses: number;
  toolCalls: number;
  url: string;
};

async function startAuthenticatedMcpProofServer() {
  const endpoints: AuthenticatedMcpProofEndpoint[] = [];

  const addEndpoint = async (owner: string, authorization: string) => {
    const server = new McpServer({ name: `openclaw-${owner}-proof`, version: "1.0.0" });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
    });
    const endpoint: AuthenticatedMcpProofEndpoint = {
      owner,
      authorization,
      path: `/mcp/${owner}`,
      server,
      transport,
      requests: 0,
      unauthorizedRequests: 0,
      streamedResponses: 0,
      toolCalls: 0,
      url: "",
    };
    server.registerTool(
      "owner_probe",
      { description: "Prove MCP resolver ownership" },
      async () => {
        endpoint.toolCalls += 1;
        return { content: [{ type: "text" as const, text: endpoint.owner }] };
      },
    );
    await server.connect(transport);
    endpoints.push(endpoint);
    return endpoint;
  };

  const mail = await addEndpoint("mail", "Bearer test-mcp-mail-owner");
  const activeDrive = await addEndpoint("active-drive", "Bearer test-mcp-active-drive-owner");
  const pinnedDrive = await addEndpoint("pinned-drive", "Bearer test-mcp-pinned-drive-owner");
  const endpointsByPath = new Map(endpoints.map((endpoint) => [endpoint.path, endpoint]));
  const server = http.createServer((request, response) => {
    const endpoint = endpointsByPath.get(request.url ?? "");
    if (!endpoint) {
      response.writeHead(404).end();
      return;
    }
    endpoint.requests += 1;
    if (request.headers.authorization !== endpoint.authorization) {
      endpoint.unauthorizedRequests += 1;
      response.writeHead(401).end();
      return;
    }
    const writeHead = response.writeHead.bind(response);
    response.writeHead = ((
      statusCode: number,
      statusMessageOrHeaders?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
      headers?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    ) => {
      // Hono passes SDK response headers directly to writeHead; getHeader cannot observe them.
      const responseHeaders =
        typeof statusMessageOrHeaders === "string" ? headers : statusMessageOrHeaders;
      if (responseHeaders && !Array.isArray(responseHeaders)) {
        const contentType = Object.entries(responseHeaders).find(
          ([name]) => name.toLowerCase() === "content-type",
        )?.[1];
        if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
          endpoint.streamedResponses += 1;
        }
      }
      return typeof statusMessageOrHeaders === "string"
        ? writeHead(statusCode, statusMessageOrHeaders, headers)
        : writeHead(statusCode, statusMessageOrHeaders);
    }) as typeof response.writeHead;
    void endpoint.transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP proof server did not acquire a loopback port");
  }
  for (const endpoint of endpoints) {
    endpoint.url = `http://127.0.0.1:${address.port}${endpoint.path}`;
  }

  return {
    mail,
    activeDrive,
    pinnedDrive,
    close: async () => {
      await Promise.all(endpoints.map((endpoint) => endpoint.server.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createMcpProofPluginRegistry() {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });

  return {
    registry: pluginRegistry.registry,
    apiFor: (pluginId: string) => {
      const record = createPluginRecord({
        id: pluginId,
        source: `/plugins/${pluginId}/index.ts`,
      });
      pluginRegistry.registry.plugins.push(record);
      return pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    },
  };
}

afterEach(() => {
  testing.setMcpServerConnectionResolversForTest();
  testing.setMcpConnectionResolverTimeoutMsForTest();
  testing.setMcpConnectionRevalidateMsForTest();
  resetPluginRuntimeStateForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mcp connection resolver helpers", () => {
  it("partitions static vs requester-scoped servers deterministically", () => {
    testing.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://example.test" }),
      },
    ]);
    const { staticServers, requesterScopedServerNames } = partitionMcpServersByConnectionScope({
      shared: { command: "true" },
      "user-mail": { transport: "streamable-http" },
      zebra: { command: "z" },
    });
    expect(Object.keys(staticServers)).toEqual(["shared", "zebra"]);
    expect(requesterScopedServerNames).toEqual(["user-mail"]);
  });

  it("preserves own __proto__ server entries while keeping deterministic order", () => {
    const servers = JSON.parse(
      '{"zebra":{"command":"z"},"__proto__":{"command":"proto"}}',
    ) as Record<string, { command: string }>;

    const { staticServers, requesterScopedServerNames } =
      partitionMcpServersByConnectionScope(servers);

    expect(Object.keys(staticServers)).toEqual(
      Object.keys(servers).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(staticServers).toStrictEqual(servers);
    expect(Object.hasOwn(staticServers, "__proto__")).toBe(true);
    expect(requesterScopedServerNames).toEqual([]);
  });

  it("resolves registrations from the authoritative request registry", async () => {
    const root = createMcpProofPluginRegistry();
    root.apiFor("root-mail").registerMcpServerConnectionResolver({
      serverName: "root-mail",
      resolve: async () => ({ url: "https://root.example.test" }),
    });
    const scoped = createMcpProofPluginRegistry();
    scoped.apiFor("scoped-mail").registerMcpServerConnectionResolver({
      serverName: "scoped-mail",
      resolve: async () => ({ url: "https://scoped.example.test" }),
    });
    setActivePluginRegistry(root.registry);

    await withPluginRuntimeRegistryScope(scoped.registry, async () => {
      await expect(
        resolveRequesterScopedMcpConnections({
          serverNames: ["scoped-mail"],
          requesterSenderId: "requester",
        }),
      ).resolves.toEqual(new Map([["scoped-mail", { url: "https://scoped.example.test" }]]));
    });
    await expect(
      resolveRequesterScopedMcpConnections({
        serverNames: ["scoped-mail"],
        requesterSenderId: "requester",
      }),
    ).resolves.toEqual(new Map());
  });

  it("revokes MCP credentials during a full gateway plugin-disable replacement", async () => {
    const proof = await startAuthenticatedMcpProofServer();
    const previousExternalRestartPolicy = isGatewaySigusr1RestartExternallyAllowed();

    try {
      // Model catalog provisioning is independent of plugin-owned MCP revocation.
      // Keep both Gateway refresh calls observable without starting provider discovery.
      const refreshPreparedModelRuntimeSnapshots = vi
        .spyOn(await import("./prepared-model-runtime.js"), "refreshPreparedModelRuntimeSnapshots")
        .mockResolvedValue(undefined);
      const refreshContextWindowCache = vi
        .spyOn(await import("./context.js"), "refreshContextWindowCache")
        .mockResolvedValue(undefined);
      const previous = createMcpProofPluginRegistry();
      previous.apiFor("startup-mail").registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => ({
          url: proof.mail.url,
          headers: { Authorization: proof.mail.authorization },
        }),
      });
      setActivePluginRegistry(previous.registry);

      const beforeDisable = await resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail"],
        requesterSenderId: "existing-before-disable",
      });
      const previousConnection = beforeDisable.get("user-mail");
      expect(previousConnection?.url).toBe(proof.mail.url);
      if (!previousConnection) {
        throw new Error("Expected an authorized MCP connection before plugin disable");
      }
      const sessionId = "gateway-plugin-disable-mcp-proof";
      const previousRuntime = await getOrCreateSessionMcpRuntime({
        sessionId,
        sessionKey: "agent:test:gateway-plugin-disable-mcp-proof",
        workspaceDir: process.cwd(),
        cfg: {
          mcp: {
            servers: {
              "user-mail": {
                transport: "streamable-http",
                url: "https://placeholder.invalid/mail",
              },
            },
          },
        },
        requesterSenderId: "existing-before-disable",
        agentAccountId: "proof-bot",
        messageChannel: "telegram",
      });
      expect(peekSessionMcpRuntime({ sessionId })).toBeDefined();
      await expect(previousRuntime.callTool("user-mail", "owner_probe", {})).resolves.toMatchObject(
        { content: [{ type: "text", text: "mail" }] },
      );
      expect(proof.mail.streamedResponses).toBeGreaterThanOrEqual(3);

      const reloadPlan = buildGatewayReloadPlan(["plugins.entries.startup-mail.enabled"]);
      expect(reloadPlan).toMatchObject({
        reloadPlugins: true,
        disposeMcpRuntimes: true,
      });

      const replacement = createMcpProofPluginRegistry();
      replacement.apiFor("active-drive").registerMcpServerConnectionResolver({
        serverName: "user-drive",
        resolve: async () => ({
          url: proof.activeDrive.url,
          headers: { Authorization: proof.activeDrive.authorization },
        }),
      });
      expect(isPluginRegistryRetired(previous.registry)).toBe(false);

      type GatewayReloadProofState = ReturnType<
        Parameters<typeof createGatewayReloadHandlers>[0]["getState"]
      >;
      let gatewayState: GatewayReloadProofState = {
        hooksConfig: null,
        hookClientIpConfig: { trustedProxies: undefined, allowRealIpFallback: false },
        heartbeatRunner: { stop() {}, updateConfig() {} },
        cronState: {
          cron: {
            async start() {},
            stop() {},
          } as GatewayReloadProofState["cronState"]["cron"],
          storePath: "/tmp/openclaw-mcp-gateway-reload-proof-cron",
          cronEnabled: false,
          reconcileExitWatchers: async () => {},
          reconcileStreamWatchers: async () => {},
          stopStreamWatchers: async () => {},
          reconcileHeartbeatJobs: async () => "converged" as const,
        },
        channelHealthMonitor: null,
      };
      const reloadLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const requestRecoveryRestart = vi.fn(() => ({ status: "failed" as const }));
      const nextConfig: OpenClawConfig = {
        plugins: {
          entries: {
            "startup-mail": { enabled: false },
            "active-drive": { enabled: true },
          },
        },
        mcp: {
          servers: {
            "user-drive": {
              transport: "streamable-http",
              url: "https://placeholder.invalid/drive",
            },
          },
        },
      };
      const gatewayReload = createGatewayReloadHandlers({
        deps: {},
        broadcast() {},
        getState: () => gatewayState,
        setState(nextState) {
          gatewayState = nextState;
        },
        async startChannel() {},
        async stopChannel() {},
        pruneInactiveChannelAccountState() {},
        async reloadPlugins({ beforeReplace, commitRuntime }) {
          await beforeReplace(new Set());
          await commitRuntime();
          setActivePluginRegistry(replacement.registry);
          return { restartChannels: new Set(), activeChannels: new Set() };
        },
        logHooks: reloadLog,
        logChannels: reloadLog,
        logCron: reloadLog,
        logReload: reloadLog,
        cronReconciliation: createGatewayCronReconciliation({
          port: 0,
          workspaceDir: process.cwd(),
          isClosing: () => false,
          async runHook() {},
        }),
        createHealthMonitor: () => null,
        requestRecoveryRestart,
      });

      await expect(gatewayReload.applyHotReload(reloadPlan, nextConfig)).resolves.toBe("applied");
      expect(refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(nextConfig, {
        allowGatewaySubagentBinding: true,
        catalogMode: "static",
      });
      expect(refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(isPluginRegistryRetired(previous.registry)).toBe(true);
      expect(peekSessionMcpRuntime({ sessionId })).toBeUndefined();

      const legacyRequests = proof.mail.requests;
      await expect(previousRuntime.callTool("user-mail", "owner_probe", {})).rejects.toThrow(
        "bundle-mcp runtime disposed for session gateway-plugin-disable-mcp-proof",
      );
      expect(proof.mail.requests).toBe(legacyRequests);
      await expect(
        resolveRequesterScopedMcpConnections({
          serverNames: ["user-drive", "user-mail"],
          requesterSenderId: "brand-new-after-disable",
        }),
      ).resolves.toEqual(
        new Map([
          [
            "user-drive",
            {
              url: proof.activeDrive.url,
              headers: { Authorization: proof.activeDrive.authorization },
            },
          ],
        ]),
      );

      const nextSessionId = "gateway-plugin-disable-brand-new-mcp-proof";
      const nextRuntime = await getOrCreateSessionMcpRuntime({
        sessionId: nextSessionId,
        sessionKey: "agent:test:gateway-plugin-disable-brand-new-mcp-proof",
        workspaceDir: process.cwd(),
        cfg: nextConfig,
        requesterSenderId: "brand-new-after-disable",
        agentAccountId: "proof-bot",
        messageChannel: "telegram",
      });
      expect(peekSessionMcpRuntime({ sessionId: nextSessionId })).toBeDefined();
      await expect(nextRuntime.callTool("user-drive", "owner_probe", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "active-drive" }],
      });
      await expect(nextRuntime.callTool("user-mail", "owner_probe", {})).rejects.toThrow();
      expect(proof.activeDrive.toolCalls).toBe(1);
      expect(proof.activeDrive.streamedResponses).toBeGreaterThanOrEqual(3);
      expect(proof.mail.requests).toBe(legacyRequests);
      expect(proof.mail.toolCalls).toBe(1);
      expect(proof.pinnedDrive.requests).toBe(0);
    } finally {
      await disposeAllSessionMcpRuntimes();
      clearCurrentProviderAuthState();
      resetPreparedModelRuntimeSnapshotsForTest();
      setGatewaySigusr1RestartPolicy({ allowExternal: previousExternalRestartPolicy });
      await proof.close();
    }
  });

  it("fails closed without requesterSenderId and drops null resolutions", async () => {
    testing.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async (ctx) =>
          ctx.requesterSenderId === "ok" ? { url: "https://example.test/ok" } : null,
      },
    ]);
    await expect(
      resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail"],
      }),
    ).resolves.toEqual(new Map());
    await expect(
      resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail"],
        requesterSenderId: "nope",
      }),
    ).resolves.toEqual(new Map());
    await expect(
      resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail"],
        requesterSenderId: "ok",
      }),
    ).resolves.toEqual(new Map([["user-mail", { url: "https://example.test/ok" }]]));
  });

  it("registers resolved header and signed-URL credentials for redaction", async () => {
    const { resetSecretRedactionRegistryForTest } =
      await import("../logging/secret-redaction-registry.test-support.js");
    resetSecretRedactionRegistryForTest();
    testing.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({
          url: "https://mcp.example.test/mail?sig=placeholder-signature",
          headers: { Authorization: "Bearer test-auth-token" },
        }),
      },
    ]);
    await resolveRequesterScopedMcpConnections({
      serverNames: ["user-mail"],
      requesterSenderId: "sender",
    });
    expect(isSecretValueRegisteredForRedaction("Bearer test-auth-token")).toBe(true);
    expect(isSecretValueRegisteredForRedaction("test-auth-token")).toBe(true);
    expect(isSecretValueRegisteredForRedaction("placeholder-signature")).toBe(true);
    // Full URL too: transport connect errors embed it verbatim (path-borne
    // session tokens would otherwise leak through fetch/undici error strings).
    expect(
      isSecretValueRegisteredForRedaction(
        "https://mcp.example.test/mail?sig=placeholder-signature",
      ),
    ).toBe(true);
    resetSecretRedactionRegistryForTest();
  });

  it("contains per-server resolve throws without rejecting the map", async () => {
    const logWarn = vi.spyOn(await import("../logger.js"), "logWarn").mockImplementation(() => {});
    testing.setMcpServerConnectionResolversForTest([
      {
        pluginId: "broken-plugin",
        serverName: "user-mail",
        resolve: async () => {
          throw new Error("Authorization: Bearer secret-token");
        },
      },
      {
        pluginId: "ok-plugin",
        serverName: "other",
        resolve: async () => ({ url: "https://example.test/other" }),
      },
    ]);
    await expect(
      resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail", "other"],
        requesterSenderId: "sender",
      }),
    ).resolves.toEqual(new Map([["other", { url: "https://example.test/other" }]]));
    expect(logWarn).toHaveBeenCalledWith(
      'bundle-mcp: connection resolver for server "user-mail" (plugin "broken-plugin") failed with resolver error',
    );
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).not.toContain("secret-token");
    expect(logged).not.toContain("Bearer");
    expect(logged).not.toContain("Authorization");
  });

  it("resolves stalled servers concurrently within one timeout window", async () => {
    testing.setMcpConnectionResolverTimeoutMsForTest(50);
    testing.setMcpServerConnectionResolversForTest([
      {
        pluginId: "hang-a",
        serverName: "mail-a",
        resolve: () => new Promise(() => {}),
      },
      {
        pluginId: "hang-b",
        serverName: "mail-b",
        resolve: () => new Promise(() => {}),
      },
    ]);
    vi.useFakeTimers();
    const pending = resolveRequesterScopedMcpConnections({
      serverNames: ["mail-a", "mail-b"],
      requesterSenderId: "sender",
    });
    // Concurrent resolves: one timeout window covers both stalls, not two sequential waits.
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual(new Map());
  });

  it("omits stalled resolvers after the resolve timeout", async () => {
    testing.setMcpConnectionResolverTimeoutMsForTest(50);
    testing.setMcpServerConnectionResolversForTest([
      {
        pluginId: "hang-plugin",
        serverName: "user-mail",
        resolve: () => new Promise(() => {}),
      },
      {
        pluginId: "ok-plugin",
        serverName: "other",
        resolve: async () => ({ url: "https://example.test/other" }),
      },
    ]);
    vi.useFakeTimers();
    const pending = resolveRequesterScopedMcpConnections({
      serverNames: ["user-mail", "other"],
      requesterSenderId: "sender",
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual(
      new Map([["other", { url: "https://example.test/other" }]]),
    );
  });

  it("uses an ephemeral keyed digest, not a plain SHA-256 of credentials", async () => {
    const crypto = await import("node:crypto");
    const a = new Map<string, { url: string; headers?: Record<string, string> }>([
      [
        "mail",
        {
          url: "https://example.test/a",
          headers: { Authorization: "Bearer test-auth-token", "X-B": "2" },
        },
      ],
    ]);
    const rotated = new Map<string, { url: string; headers?: Record<string, string> }>([
      [
        "mail",
        {
          url: "https://example.test/a",
          headers: { Authorization: "Bearer secret-token", "X-B": "2" },
        },
      ],
    ]);
    const same = new Map<string, { url: string; headers?: Record<string, string> }>([
      [
        "mail",
        {
          url: "https://example.test/a",
          headers: { "X-B": "2", Authorization: "Bearer test-auth-token" },
        },
      ],
    ]);
    const digest = hashMcpResolvedConnections(a);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpResolvedConnections(a)).toBe(digest);
    expect(hashMcpResolvedConnections(same)).toBe(digest);
    expect(hashMcpResolvedConnections(rotated)).not.toBe(digest);
    const plainTuples = JSON.stringify([
      [
        "mail",
        "https://example.test/a",
        [
          ["Authorization", "Bearer test-auth-token"],
          ["X-B", "2"],
        ],
      ],
    ]);
    const plainSha = crypto.createHash("sha256").update(plainTuples).digest("hex");
    expect(digest).not.toBe(plainSha);
  });

  it("normalizes incompatible static fields when applying connection overrides", () => {
    const servers = {
      "user-mail": {
        transport: "stdio",
        type: "stdio",
        command: "/bin/echo",
        args: ["serve"],
        auth: "oauth",
        oauth: { scope: "mail" },
        url: "https://placeholder.example",
        headers: { Authorization: "test-auth-token" },
        toolFilter: { include: ["send"] },
      },
    };
    const redacted = redactMcpServersForFingerprint(servers, new Set(["user-mail"]));
    expect(redacted).toEqual({
      "user-mail": {
        transport: "stdio",
        type: "stdio",
        toolFilter: { include: ["send"] },
        auth: "oauth",
        oauth: { scope: "mail" },
        connection: "requester-scoped",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("test-auth-token");
    expect(JSON.stringify(redacted)).not.toContain("placeholder");

    const applied = applyMcpConnectionOverride(servers["user-mail"], {
      url: "https://live.example/user",
      headers: { Authorization: "Bearer test-auth-token" },
    });
    expect(applied).toEqual({
      transport: "streamable-http",
      url: "https://live.example/user",
      headers: { Authorization: "Bearer test-auth-token" },
      toolFilter: { include: ["send"] },
    });
    expect(applied).not.toHaveProperty("auth");
    expect(applied).not.toHaveProperty("oauth");
    expect(applied).not.toHaveProperty("command");
    expect(applied).not.toHaveProperty("type");
    expect(servers["user-mail"].headers).toEqual({ Authorization: "test-auth-token" });

    const sseKept = applyMcpConnectionOverride(
      { transport: "sse", toolFilter: { include: ["x"] } },
      { url: "https://live.example/sse" },
    );
    expect(sseKept.transport).toBe("sse");
    expect(sseKept.url).toBe("https://live.example/sse");

    const sseFromType = applyMcpConnectionOverride(
      { type: "sse", toolFilter: { include: ["x"] } },
      { url: "https://live.example/sse-type" },
    );
    expect(sseFromType.transport).toBe("sse");
    expect(sseFromType).not.toHaveProperty("type");

    const sseCase = applyMcpConnectionOverride(
      { transport: "SSE" },
      { url: "https://live.example/sse-case" },
    );
    expect(sseCase.transport).toBe("sse");
  });

  it("builds stable requester cache keys", () => {
    expect(
      buildMcpRequesterRuntimeCacheKey({
        sessionId: "s1",
        messageChannel: "telegram",
        agentAccountId: "bot",
        requesterSenderId: "user-1",
      }),
    ).toBe(
      JSON.stringify({
        sessionId: "s1",
        messageChannel: "telegram",
        agentAccountId: "bot",
        requesterSenderId: "user-1",
      }),
    );
  });
});
