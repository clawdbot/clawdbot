/** Unit tests for requester-scoped MCP connection resolver helpers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  pinActivePluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  applyMcpConnectionOverride,
  buildMcpRequesterRuntimeCacheKey,
  hashMcpResolvedConnections,
  partitionMcpServersByConnectionScope,
  redactMcpServersForFingerprint,
  resolveRequesterScopedMcpConnections,
  testing,
} from "./mcp-connection-resolver.js";

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

  it("keeps connection resolvers from pinned live registries", async () => {
    const pinnedRegistry = createEmptyPluginRegistry();
    pinnedRegistry.mcpServerConnectionResolvers.push({
      pluginId: "startup-mail",
      source: "test",
      resolver: {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/startup" }),
      },
    });
    pinnedRegistry.mcpServerConnectionResolvers.push({
      pluginId: "startup-drive",
      source: "test",
      resolver: {
        serverName: "user-drive",
        resolve: async () => ({ url: "https://mcp.example.test/stale-drive" }),
      },
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.mcpServerConnectionResolvers.push({
      pluginId: "active-drive",
      source: "test",
      resolver: {
        serverName: "user-drive",
        resolve: async () => ({ url: "https://mcp.example.test/active" }),
      },
    });

    setActivePluginRegistry(pinnedRegistry);
    pinActivePluginHttpRouteRegistry(pinnedRegistry);
    setActivePluginRegistry(activeRegistry);

    const { staticServers, requesterScopedServerNames } = partitionMcpServersByConnectionScope({
      shared: { command: "true" },
      "user-drive": { transport: "streamable-http" },
      "user-mail": { transport: "streamable-http" },
    });
    expect(Object.keys(staticServers)).toEqual(["shared"]);
    expect(requesterScopedServerNames).toEqual(["user-drive", "user-mail"]);
    await expect(
      resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail", "user-drive"],
        requesterSenderId: "sender",
      }),
    ).resolves.toEqual(
      new Map([
        ["user-drive", { url: "https://mcp.example.test/active" }],
        ["user-mail", { url: "https://mcp.example.test/startup" }],
      ]),
    );
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
    const { isSecretValueRegisteredForRedaction } =
      await import("../logging/secret-redaction-registry.js");
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
