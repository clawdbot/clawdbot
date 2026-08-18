// Verifies OpenClaw plugin tools are resolved with browser/runtime context.
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "./auth-profiles/runtime-snapshots.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  getPreparedPluginRuntimeLoadContext,
  prepareOwnedPluginLoadContext,
} from "./prepared-model-runtime.plugin-context.js";

const hoisted = vi.hoisted(() => ({
  resolvePluginTools: vi.fn(),
}));
const TEST_AGENT_DIR = path.join(os.tmpdir(), "openclaw-plugin-tool-auth-test");
const observedGatewayCallerIdentities: unknown[] = [];

vi.mock("../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/tools.js")>()),
  resolvePluginTools: (...args: unknown[]) => hoisted.resolvePluginTools(...args),
}));

function firstResolvePluginToolsParams(): Record<string, unknown> {
  // Captures the plugin runtime contract passed from OpenClaw tool resolution.
  const call = hoisted.resolvePluginTools.mock.calls[0];
  if (!call) {
    throw new Error("Expected plugin tool resolution");
  }
  return call[0] as Record<string, unknown>;
}

describe("createOpenClawTools browser plugin integration", () => {
  afterEach(() => {
    hoisted.resolvePluginTools.mockReset();
    vi.unstubAllEnvs();
    clearSecretsRuntimeSnapshot();
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
  });

  it("keeps the browser tool returned by plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([
      {
        name: "browser",
        description: "browser fixture tool",
        parameters: {
          type: "object",
          properties: {},
        },
        async execute() {
          return {
            content: [{ type: "text", text: "ok" }],
          };
        },
      },
    ]);

    const config = {
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    const tools = resolveOpenClawPluginToolsForOptions({
      options: { config },
      resolvedConfig: config,
    });

    expect(tools.map((tool) => tool.name)).toContain("browser");
  });

  it("omits the browser tool when plugin resolution returns no browser tool", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);

    const config = {
      plugins: {
        allow: ["browser"],
        entries: {
          browser: {
            enabled: false,
          },
        },
      },
    } as OpenClawConfig;

    const tools = resolveOpenClawPluginToolsForOptions({
      options: { config },
      resolvedConfig: config,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("browser");
  });

  it("forwards fsPolicy into plugin tool context", async () => {
    let capturedContext: { fsPolicy?: { workspaceOnly: boolean } } | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      const resolvedParams = params as { context?: { fsPolicy?: { workspaceOnly: boolean } } };
      capturedContext = resolvedParams.context;
      return [
        {
          name: "browser",
          description: "browser fixture tool",
          parameters: {
            type: "object",
            properties: {},
          },
          async execute() {
            return {
              content: [{ type: "text", text: "ok" }],
              details: { workspaceOnly: capturedContext?.fsPolicy?.workspaceOnly ?? null },
            };
          },
        },
      ];
    });

    const tools = resolveOpenClawPluginToolsForOptions({
      options: {
        config: {
          plugins: {
            allow: ["browser"],
          },
        } as OpenClawConfig,
        fsPolicy: { workspaceOnly: true },
      },
      resolvedConfig: {
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
    });

    const browserTool = tools.find((tool) => tool.name === "browser");
    if (browserTool === undefined) {
      throw new Error("expected browser tool");
    }

    const result = await browserTool.execute("tool-call", {});
    const details = (result.details ?? {}) as { workspaceOnly?: boolean | null };
    expect(details.workspaceOnly).toBe(true);
  });

  it("forwards gateway subagent binding to plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const config = {
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: { config, allowGatewaySubagentBinding: true },
      resolvedConfig: config,
    });

    expect(hoisted.resolvePluginTools).toHaveBeenCalledTimes(1);
    expect(firstResolvePluginToolsParams().allowGatewaySubagentBinding).toBe(true);
  });

  it("forwards the lifecycle registry to workspace-scoped plugin tools", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const config = { plugins: { enabled: true } } as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(pluginRegistry, "gateway", "gateway-bindable", "/gateway-workspace");

    resolveOpenClawPluginToolsForOptions({
      options: { config, workspaceDir: "/session-workspace" },
      resolvedConfig: config,
    });

    expect(firstResolvePluginToolsParams().runtimeRegistry).toBe(pluginRegistry);
  });

  it("forwards lifecycle-prepared plugin facts to plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const config = { plugins: { enabled: true } } as OpenClawConfig;
    const pluginRegistry = { tools: [] } as never;
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([]),
      workspaceDir: "/tmp",
    });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(metadataSnapshot);
    try {
      expect(
        prepareOwnedPluginLoadContext(
          { agentDir: "/tmp/agent", config, workspaceDir: "/tmp" },
          process.env,
          pluginRegistry,
        ),
      ).toBe(metadataSnapshot);
    } finally {
      resolveMetadata.mockRestore();
    }
    const loadContext = getPreparedPluginRuntimeLoadContext(pluginRegistry);
    if (!loadContext) {
      throw new Error("expected prepared plugin load context");
    }

    resolveOpenClawPluginToolsForOptions({
      options: {
        config,
        workspaceDir: "/tmp",
        preparedModelRuntime: {
          agentDir: "/tmp/agent",
          workspaceDir: "/tmp",
          activeProjectKeys: [],
          config,
          authModes: {},
          metadataSnapshot,
          pluginRegistry,
          allowGatewaySubagentBinding: false,
          modelCatalog: { entries: [], routeVariants: [] },
          configuredRuntimeModels: [],
          inlineProviderModels: [],
          createStores: vi.fn(),
        },
      },
      resolvedConfig: config,
    });

    expect(firstResolvePluginToolsParams().preparedRuntime).toEqual({
      loadContext,
      metadataSnapshot,
      registry: pluginRegistry,
    });
  });

  it("forwards auth profile helpers to plugin resolution and context", async () => {
    let capturedParams:
      | {
          hasAuthForProvider?: (providerId: string) => boolean;
          context?: {
            hasAuthForProvider?: (providerId: string) => boolean;
            resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
          };
        }
      | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      capturedParams = params as typeof capturedParams;
      return [];
    });
    const config = {
      auth: {
        order: {
          xai: ["xai-profile"],
        },
      },
      plugins: {
        allow: ["xai"],
      },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: {
        config,
        agentDir: TEST_AGENT_DIR,
        authProfileStore: {
          version: 1,
          profiles: {
            "xai-excluded": {
              type: "api_key",
              provider: "xai",
              key: "xai-excluded-key", // pragma: allowlist secret
            },
            "xai-profile": {
              type: "api_key",
              provider: "xai",
              key: "xai-profile-key", // pragma: allowlist secret
            },
          },
        },
      },
      resolvedConfig: config,
    });

    expect(capturedParams?.hasAuthForProvider?.("xai")).toBe(true);
    expect(capturedParams?.context?.hasAuthForProvider?.("xai")).toBe(true);
    await expect(capturedParams?.context?.resolveApiKeyForProvider?.("xai")).resolves.toBe(
      "xai-profile-key",
    );
  });

  it("keeps provider availability and credential resolution aligned for env-only auth", async () => {
    const envName = "OPENCLAW_PLUGIN_TOOL_AUTH_TEST_KEY";
    vi.stubEnv(envName, "env-only-key");
    let capturedParams:
      | {
          hasAuthForProvider?: (providerId: string) => boolean;
          context?: {
            hasAuthForProvider?: (providerId: string) => boolean;
            resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
          };
        }
      | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      capturedParams = params as typeof capturedParams;
      return [];
    });
    const config = {
      models: {
        providers: {
          acme: {
            baseUrl: "https://example.com/v1",
            apiKey: `\${${envName}}`,
            models: [],
          },
        },
      },
      plugins: { allow: ["xai"] },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: {
        config,
        agentDir: TEST_AGENT_DIR,
        workspaceDir: "/workspace",
        authProfileStore: { version: 1, profiles: {} },
      },
      resolvedConfig: config,
    });

    expect(capturedParams?.hasAuthForProvider?.("acme")).toBe(true);
    expect(capturedParams?.context?.hasAuthForProvider?.("acme")).toBe(true);
    await expect(capturedParams?.context?.resolveApiKeyForProvider?.("acme")).resolves.toBe(
      "env-only-key",
    );
  });

  it("keeps ordered profile precedence when runtime auth is also available", async () => {
    vi.stubEnv("ACME_API_KEY", "env-key");
    let resolveApiKeyForProvider: ((providerId: string) => Promise<string | undefined>) | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      resolveApiKeyForProvider = (
        params as {
          context?: {
            resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
          };
        }
      ).context?.resolveApiKeyForProvider;
      return [];
    });
    const config = {
      auth: { order: { acme: ["acme:profile"] } },
      models: {
        providers: {
          acme: {
            baseUrl: "https://example.com/v1",
            apiKey: "${ACME_API_KEY}",
            models: [],
          },
        },
      },
      plugins: { allow: ["xai"] },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: {
        config,
        agentDir: TEST_AGENT_DIR,
        authProfileStore: {
          version: 1,
          profiles: {
            "acme:profile": {
              type: "api_key",
              provider: "acme",
              key: "profile-key", // pragma: allowlist secret
            },
          },
        },
      },
      resolvedConfig: config,
    });

    await expect(resolveApiKeyForProvider?.("acme")).resolves.toBe("profile-key");
  });

  it("preserves ungated plugin resolution when no authoritative auth store is supplied", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const config = { plugins: { allow: ["browser"] } } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: { config, agentDir: "/unread-auth-store" },
      resolvedConfig: config,
    });

    const params = firstResolvePluginToolsParams() as {
      hasAuthForProvider?: unknown;
      context?: { hasAuthForProvider?: unknown; resolveApiKeyForProvider?: unknown };
    };
    expect(params.hasAuthForProvider).toBeUndefined();
    expect(params.context?.hasAuthForProvider).toBeUndefined();
    expect(params.context?.resolveApiKeyForProvider).toBeUndefined();
  });

  it("forwards plugin tool deny policy to plugin resolution", () => {
    hoisted.resolvePluginTools.mockReturnValue([]);
    const config = {
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    resolveOpenClawPluginToolsForOptions({
      options: {
        config,
        pluginToolAllowlist: ["*"],
        pluginToolDenylist: ["browser"],
      },
      resolvedConfig: config,
    });

    expect(hoisted.resolvePluginTools).toHaveBeenCalledTimes(1);
    const params = firstResolvePluginToolsParams();
    expect(params.toolAllowlist).toEqual(["*"]);
    expect(params.toolDenylist).toEqual(["browser"]);
  });

  it("does not pass a stale active snapshot as plugin runtime config for a resolved run config", () => {
    // Resolved run config must win over any process-global runtime snapshot.
    const staleSourceConfig = {
      plugins: {
        allow: ["old-plugin"],
      },
    } as OpenClawConfig;
    const staleRuntimeConfig = {
      plugins: {
        allow: ["old-plugin"],
      },
    } as OpenClawConfig;
    const resolvedRunConfig = {
      plugins: {
        allow: ["browser"],
      },
      tools: {
        updatePlan: true,
      },
    } as OpenClawConfig;
    let capturedRuntimeConfig: OpenClawConfig | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      capturedRuntimeConfig = (params as { context?: { runtimeConfig?: OpenClawConfig } }).context
        ?.runtimeConfig;
      return [];
    });
    activateSecretsRuntimeSnapshot({
      sourceConfig: staleSourceConfig,
      config: staleRuntimeConfig,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {
        search: {
          providerSource: "none",
          diagnostics: [],
        },
        fetch: {
          providerSource: "none",
          diagnostics: [],
        },
        diagnostics: [],
      },
    });

    resolveOpenClawPluginToolsForOptions({
      options: { config: resolvedRunConfig },
      resolvedConfig: resolvedRunConfig,
    });

    expect(capturedRuntimeConfig).toBe(resolvedRunConfig);
  });

  it("does not let a source-less pinned config snapshot override explicit plugin tool config", () => {
    const pinnedRuntimeConfig = {
      plugins: {
        allow: ["old-plugin"],
      },
    } as OpenClawConfig;
    const explicitConfig = {
      plugins: {
        allow: ["browser"],
      },
      tools: {
        updatePlan: true,
      },
    } as OpenClawConfig;
    let capturedRuntimeConfig: OpenClawConfig | undefined;
    let getRuntimeConfig: (() => OpenClawConfig | undefined) | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      const context = (
        params as {
          context?: {
            runtimeConfig?: OpenClawConfig;
            getRuntimeConfig?: () => OpenClawConfig | undefined;
          };
        }
      ).context;
      capturedRuntimeConfig = context?.runtimeConfig;
      getRuntimeConfig = context?.getRuntimeConfig;
      return [];
    });
    setRuntimeConfigSnapshot(pinnedRuntimeConfig);

    resolveOpenClawPluginToolsForOptions({
      options: { config: explicitConfig },
      resolvedConfig: explicitConfig,
    });

    expect(capturedRuntimeConfig).toBe(explicitConfig);
    expect(getRuntimeConfig?.()).toBe(explicitConfig);
  });

  it("exposes a live runtime config getter to plugin tool factories", () => {
    const sourceConfig = {
      plugins: {
        allow: ["memory-core"],
      },
    } as OpenClawConfig;
    const firstRuntimeConfig = {
      plugins: {
        allow: ["memory-core"],
        entries: { "memory-core": { enabled: true } },
      },
    } as OpenClawConfig;
    const nextRuntimeConfig = {
      plugins: {
        allow: ["memory-core"],
        entries: { "memory-core": { enabled: false } },
      },
    } as OpenClawConfig;
    let getRuntimeConfig: (() => OpenClawConfig | undefined) | undefined;
    hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
      getRuntimeConfig = (
        params as { context?: { getRuntimeConfig?: () => OpenClawConfig | undefined } }
      ).context?.getRuntimeConfig;
      return [];
    });
    setRuntimeConfigSnapshot(firstRuntimeConfig, sourceConfig);

    resolveOpenClawPluginToolsForOptions({
      options: { config: sourceConfig },
      resolvedConfig: sourceConfig,
    });

    expect(getRuntimeConfig?.()).toStrictEqual(firstRuntimeConfig);

    setRuntimeConfigSnapshot(nextRuntimeConfig, sourceConfig);

    expect(getRuntimeConfig?.()).toStrictEqual(nextRuntimeConfig);
    expect(getRuntimeConfig?.()?.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
  });
});

function requirePluginTool(name: string, overrides?: Parameters<typeof createOpenClawTools>[0]) {
  hoisted.resolvePluginTools.mockReturnValue([
    {
      name,
      label: "Synthetic direct cron plugin",
      description: "Calls Gateway cron directly like plugin-owned reminder tools.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const { getGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js");
        observedGatewayCallerIdentities.push(getGatewayToolCallerIdentity());
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  ]);
  const tool = createOpenClawTools({
    agentSessionKey: "agent:main:discord:channel:123",
    disableMessageTool: true,
    pluginToolAllowlist: [name],
    requesterAgentIdOverride: "main",
    wrapBeforeToolCallHook: false,
    ...overrides,
  }).find((candidate) => candidate.name === name);
  if (!tool?.execute) {
    throw new Error(`Expected executable tool ${name}`);
  }
  return tool;
}

describe("createOpenClawTools Gateway caller identity", () => {
  afterEach(() => {
    observedGatewayCallerIdentities.length = 0;
  });

  it("wraps plugin tools so direct cron Gateway calls inherit the agent identity", async () => {
    const tool = requirePluginTool("synthetic_direct_cron_plugin");
    await tool.execute("tool-call-1", {});

    expect(observedGatewayCallerIdentities).toEqual([
      { agentId: "main", sessionKey: "agent:main:discord:channel:123" },
    ]);
  });

  it("carries trusted turn-source routing with the agent identity", async () => {
    const tool = requirePluginTool("synthetic_direct_cron_plugin", {
      agentChannel: "discord",
      agentTo: "channel:123",
      agentAccountId: "work",
      agentThreadId: "thread-7",
    });
    await tool.execute("tool-call-2", {});

    expect(observedGatewayCallerIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "work",
        turnSourceThreadId: "thread-7",
      },
    ]);
  });

  it("uses scheduled creator account authority without changing live delivery routing", async () => {
    const tool = requirePluginTool("synthetic_direct_cron_plugin", {
      agentChannel: "discord",
      agentTo: "channel:123",
      agentAccountId: "delivery-account",
      gatewayCallerAccountId: "creator-account",
    });
    await tool.execute("tool-call-scheduled", {});

    expect(observedGatewayCallerIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "creator-account",
      },
    ]);
  });
});
