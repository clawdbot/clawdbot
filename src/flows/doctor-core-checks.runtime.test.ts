// Doctor runtime check tests cover runtime-backed doctor checks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { GATEWAY_HEALTH_RATE_LIMITED_MESSAGE } from "../commands/gateway-health-auth-diagnostic.js";
import { GatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { setPluginToolMeta } from "../plugins/tools.js";

const mocks = vi.hoisted(() => ({
  createBundleMcpToolRuntime: vi.fn(),
  createOpenClawCodingTools: vi.fn(),
  disposeBundleRuntime: vi.fn(),
  loadModelCatalog: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  buildGatewayProbeConnectionDetails: vi.fn(),
  callGateway: vi.fn(),
  isGatewayCredentialsRequiredError: vi.fn(),
  isContainerEnvironment: vi.fn(() => false),
  readGatewayServiceState: vi.fn(),
  resolveGatewayService: vi.fn(() => ({ label: "openclaw-gateway" })),
  resolvePluginProvidersCore: vi.fn((): Array<Record<string, unknown>> => []),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: (
    catalog: Array<{ provider?: string; id?: string }>,
    provider: string,
    modelId: string,
  ) => catalog.find((entry) => entry.provider === provider && entry.id === modelId),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: mocks.createBundleMcpToolRuntime,
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: mocks.createOpenClawCodingTools,
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayProbeConnectionDetails: mocks.buildGatewayProbeConnectionDetails,
  callGateway: mocks.callGateway,
  isGatewayCredentialsRequiredError: mocks.isGatewayCredentialsRequiredError,
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: () => [],
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

vi.mock("../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-discovery.js")>()),
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

const {
  collectGatewayDaemonFindings,
  collectGatewayHealthFindings,
  collectProviderCatalogProjectionFindings,
  collectRuntimeToolSchemaFindings,
} = await import("./doctor-core-checks.runtime.js");

function tool(name: string, parameters: unknown): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
}

function bundleMcpTool(name: string, parameters: unknown): AnyAgentTool {
  const entry = tool(name, parameters);
  setPluginToolMeta(entry, { pluginId: "bundle-mcp", optional: false });
  return entry;
}

describe("doctor runtime tool schema checks", () => {
  beforeEach(() => {
    mocks.createOpenClawCodingTools.mockReset().mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockReset().mockReturnValue({
      tools: [],
      dispose: mocks.disposeBundleRuntime,
    });
    mocks.disposeBundleRuntime.mockReset().mockReturnValue(undefined);
    mocks.loadModelCatalog.mockClear();
    mocks.normalizeProviderToolSchemasWithPlugin
      .mockReset()
      .mockImplementation(({ context }) => context.tools);
    mocks.readGatewayServiceState.mockReset().mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {},
      command: { programArguments: ["openclaw", "gateway"], sourcePath: "/tmp/gateway.service" },
      runtime: { status: "running" },
    });
    mocks.resolveGatewayService.mockClear();
    mocks.resolvePluginProvidersCore.mockReset().mockReturnValue([]);
    mocks.resolveDefaultModelForAgent.mockClear();
  });

  it("reports active bundle MCP tool schemas that would be quarantined before a model turn", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [
        bundleMcpTool("fuzzplugin__healthy", { type: "object", properties: {} }),
        bundleMcpTool("fuzzplugin__move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent main tool fuzzplugin__move_angles from plugin bundle-mcp has an unsupported input schema for runtime projection.",
      path: "mcp.servers",
      target: "fuzzplugin__move_angles",
      requirement: 'fuzzplugin__move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("preserves direct OpenAI catalog transport while building doctor runtime models", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        compat: { supportsTools: true },
      },
    ]);
    mocks.createOpenClawCodingTools.mockReturnValueOnce([
      tool("healthy", { type: "object", properties: {} }),
    ]);

    await collectRuntimeToolSchemaFindings({});

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelApi: "openai-responses",
          model: expect.objectContaining({
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          }),
        }),
      }),
    );
  });

  it("preserves ChatGPT OpenAI catalog transport while building doctor runtime models", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        compat: { supportsTools: true },
      },
    ]);
    mocks.createOpenClawCodingTools.mockReturnValueOnce([
      tool("healthy", { type: "object", properties: {} }),
    ]);

    await collectRuntimeToolSchemaFindings({});

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelApi: "openai-chatgpt-responses",
          model: expect.objectContaining({
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api",
          }),
        }),
      }),
    );
  });

  it("reports bundle MCP runtime diagnostics when tool listing fails schema validation", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        'Configured MCP server "fuzzplugin" could not expose runtime tools for schema validation.',
      path: "mcp.servers.fuzzplugin",
      requirement: 'tools[0].inputSchema.type: Invalid input: expected "object"',
      fixHint:
        "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports bundle MCP runtime diagnostics for exact MCP tool allowlists", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["fuzzplugin__healthy"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.fuzzplugin",
      }),
    );
  });

  it("reports exact MCP allowlists when the safe server name contains the separator", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "my__server",
          safeServerName: "my__server",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["my__server__healthy"] },
        mcp: {
          servers: {
            my__server: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.my__server",
      }),
    );
  });

  it("reports bundle MCP runtime diagnostics for glob MCP tool allowlists", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["*__healthy"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.fuzzplugin",
      }),
    );
  });

  it("reports unsupported schemas exposed only to a non-default configured agent", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "worker"
        ? [tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/shared-workspace" },
            { id: "worker", workspace: "/tmp/shared-workspace" },
          ],
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent worker tool fuzzplugin_move_angles has an unsupported input schema for runtime projection.",
      path: "tools.fuzzplugin_move_angles",
      target: "fuzzplugin_move_angles",
      requirement: 'fuzzplugin_move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker" }),
    );
    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.loadModelCatalog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "main",
        readOnly: true,
        providerDiscoveryProviderIds: [],
      }),
    );
    expect(mocks.loadModelCatalog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "worker",
        readOnly: true,
        providerDiscoveryProviderIds: [],
      }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("skips ACP-only agents because they do not use embedded tool projection", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "acp-worker"
        ? [tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );
    mocks.createBundleMcpToolRuntime.mockImplementation(
      async (options: { workspaceDir: string }) => ({
        tools: options.workspaceDir.includes("acp")
          ? [bundleMcpTool("fuzzplugin__bad", { type: "array", items: { type: "number" } })]
          : [],
        dispose: mocks.disposeBundleRuntime,
      }),
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/main-workspace" },
            {
              id: "acp-worker",
              workspace: "/tmp/acp-workspace",
              runtime: { type: "acp" },
            },
          ],
        },
      }),
    ).resolves.toEqual([]);
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("main-workspace") }),
    );
  });

  it("loads bundled MCP runtime once per distinct agent workspace", async () => {
    mocks.createOpenClawCodingTools.mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockImplementation(
      async (options: { workspaceDir: string }) => ({
        tools: options.workspaceDir.includes("worker")
          ? [
              bundleMcpTool("fuzzplugin__move_angles", {
                type: "array",
                items: { type: "number" },
              }),
            ]
          : [bundleMcpTool("healthy", { type: "object", properties: {} })],
        dispose: mocks.disposeBundleRuntime,
      }),
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/main-workspace" },
            { id: "worker", workspace: "/tmp/worker-workspace" },
          ],
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent worker tool fuzzplugin__move_angles from plugin bundle-mcp has an unsupported input schema for runtime projection.",
      path: "mcp.servers",
      target: "fuzzplugin__move_angles",
      requirement: 'fuzzplugin__move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("main-workspace") }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("worker-workspace") }),
    );
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(2);
  });

  it("does not report bundle MCP schemas filtered out by the final runtime tool policy", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [
        bundleMcpTool("fuzzplugin__move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not report bundle MCP diagnostics filtered out by the final runtime tool policy", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not report bundle MCP diagnostics filtered out by server-level deny policy", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["fuzzplugin__*"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });
});

describe("doctor gateway runtime checks", () => {
  beforeEach(() => {
    mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
    mocks.buildGatewayProbeConnectionDetails.mockReset().mockResolvedValue({
      url: "http://127.0.0.1:5829",
    });
    mocks.callGateway.mockReset().mockResolvedValue({ degradedSecretOwners: [] });
    mocks.isGatewayCredentialsRequiredError.mockReset().mockReturnValue(false);
    mocks.readGatewayServiceState.mockReset().mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {},
      command: { programArguments: ["openclaw", "gateway"], sourcePath: "/tmp/gateway.service" },
      runtime: { status: "running" },
    });
    mocks.resolveGatewayService.mockReset().mockReturnValue({ label: "openclaw-gateway" });
  });

  it("projects every degraded SecretRef owner from exactly one authenticated read-only status RPC", async () => {
    const cfg = { gateway: { mode: "local" as const } };
    const privateToken = "SYNTHETIC_PRIVATE_URL_TOKEN";
    mocks.buildGatewayProbeConnectionDetails.mockResolvedValueOnce({
      url: "wss://127.0.0.1:5829",
      tlsFingerprint: "sha256:test-doctor-fingerprint",
      preauthHandshakeTimeoutMs: 1200,
    });
    mocks.callGateway.mockResolvedValueOnce({
      degradedSecretOwners: [
        {
          ownerKind: "account",
          ownerId: "discord:ops",
          state: "unavailable",
          paths: ["channels.discord.accounts.ops.token"],
          reason: "secret reference was not found (env:default:PRIVATE_REF_ID)",
        },
        {
          ownerKind: "capability",
          ownerId: "tts",
          state: "unavailable",
          degradationState: "stale",
          paths: ["tts.providers.elevenlabs.apiKey", "tts.providers.elevenlabs.voiceId"],
          reason: "secret provider policy denied resolution",
        },
        {
          ownerKind: "provider",
          ownerId: `vault\u001b]52;c;attack\u0007:https://user:${privateToken}@secret.test/${"a".repeat(500)}`,
          state: "unavailable",
          paths: Array.from(
            { length: 12 },
            (_, index) =>
              `providers.example.${index}.https://secret.test/value?token=${privateToken}\n${"z".repeat(400)}`,
          ),
          reason: `secret provider failed: ${privateToken}\nref PRIVATE_REF_ID`,
        },
      ],
      degradedPlugins: [{ pluginId: "not-this-check" }],
    });

    const findings = await collectGatewayHealthFindings({
      cfg,
      configPath: "/tmp/selected-openclaw.json",
    });

    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      sharedStateMode: "read-only",
      config: cfg,
      configPath: "/tmp/selected-openclaw.json",
      tlsFingerprint: "sha256:test-doctor-fingerprint",
      preauthHandshakeTimeoutMs: 1200,
    });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("cold account:discord:ops"),
        path: "channels.discord.accounts.ops.token",
        target: "account:discord:ops",
        fixHint: expect.stringContaining("openclaw secrets reload"),
      }),
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("stale capability:tts"),
        path: "tts.providers.elevenlabs.apiKey",
        target: "capability:tts",
        fixHint: expect.stringContaining("openclaw secrets reload"),
      }),
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("provider:vault"),
        path: expect.stringContaining("providers.example.0"),
        target: expect.stringContaining("provider:vault"),
      }),
    ]);
    expect(findings[1]?.message).toContain("tts.providers.elevenlabs.voiceId");
    const finding = findings[2];
    const rendered = JSON.stringify(findings);
    expect(finding?.message).toContain("omitted");
    expect(finding?.message).toContain("secret resolution failed");
    expect(finding?.message.length).toBeLessThanOrEqual(700);
    expect(finding?.target?.length).toBeLessThanOrEqual(150);
    expect(finding?.path?.length).toBeLessThanOrEqual(180);
    expect(rendered).not.toContain(privateToken);
    expect(rendered).not.toContain("PRIVATE_REF_ID");
    expect(rendered).not.toContain("not-this-check");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
  });

  it.each([
    {
      label: "missing Gateway authentication",
      error: new Error("auth token SYNTHETIC_PRIVATE_TOKEN\nref PRIVATE_REF_ID"),
      credentialsRequired: true,
      message:
        "Gateway status could not be inspected because this CLI has no usable token/password or paired device token for read-scope RPCs.",
    },
    {
      label: "an unavailable Gateway authentication SecretRef",
      error: new GatewaySecretRefUnavailableError("gateway.auth.token"),
      credentialsRequired: false,
      message:
        "Gateway status could not be inspected because this CLI has no usable token/password or paired device token for read-scope RPCs.",
    },
    {
      label: "temporary Gateway authentication rate limiting",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unauthorized: too many failed authentication attempts (retry later)",
        details: { code: "AUTH_RATE_LIMITED", authReason: "rate_limited" },
        retryable: true,
      }),
      credentialsRequired: false,
      message: GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
    },
    {
      label: "an unreachable Gateway with terminal control characters",
      error: new Error("connect ECONNREFUSED 127.0.0.1:5829\u001b]52;c;attack\u0007\u009b"),
      credentialsRequired: false,
      message: "Gateway status could not be inspected: connect ECONNREFUSED 127.0.0.1:5829",
    },
  ])("reports $label from exactly one sanitized status attempt", async (entry) => {
    mocks.callGateway.mockRejectedValueOnce(entry.error);
    mocks.isGatewayCredentialsRequiredError.mockReturnValueOnce(entry.credentialsRequired);

    const findings = await collectGatewayHealthFindings({ cfg: { gateway: { mode: "local" } } });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: entry.message,
        path: "gateway.mode",
        target: "http://127.0.0.1:5829",
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("SYNTHETIC_PRIVATE_TOKEN");
    expect(JSON.stringify(findings)).not.toContain("PRIVATE_REF_ID");
    expect(mocks.callGateway).toHaveBeenCalledOnce();
  });

  it("reports preparation failures without exposing URL credentials or control characters", async () => {
    mocks.buildGatewayProbeConnectionDetails.mockRejectedValueOnce(
      new Error(
        `invalid wss://user:${"SYNTHETIC_PRIVATE_TOKEN".repeat(20)}@gateway.test/rpc\nmore`,
      ),
    );

    const findings = await collectGatewayHealthFindings({ cfg: {} });

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("Gateway health inspection could not be prepared"),
        path: "gateway",
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("SYNTHETIC_PRIVATE_TOKEN");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("prepares the target but skips the RPC for active exec credentials unless execution is allowed", async () => {
    const cfg = {
      gateway: {
        mode: "local" as const,
        auth: {
          mode: "token" as const,
          token: { source: "exec" as const, provider: "vault", id: "PRIVATE_REF_ID" },
        },
      },
    };

    const findings = await collectGatewayHealthFindings({ cfg, env: {} });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("intentionally skipped"),
        fixHint: expect.stringContaining("--allow-exec"),
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("PRIVATE_REF_ID");
    expect(mocks.buildGatewayProbeConnectionDetails).toHaveBeenCalledOnce();
    expect(mocks.callGateway).not.toHaveBeenCalled();

    await expect(
      collectGatewayHealthFindings({ cfg, env: {}, allowExecSecretRefs: true }),
    ).resolves.toEqual([]);
    expect(mocks.callGateway).toHaveBeenCalledOnce();
  });

  it("redacts sensitive remote gateway URLs from health finding targets", async () => {
    mocks.buildGatewayProbeConnectionDetails.mockResolvedValueOnce({
      url: "wss://user:pass@gateway.example.test/rpc?token=secret&safe=value",
    });
    mocks.callGateway.mockRejectedValueOnce(new Error("remote gateway did not answer"));

    const findings = await collectGatewayHealthFindings({
      cfg: { gateway: { mode: "remote", remote: { url: "wss://gateway.example.test/rpc" } } },
    });

    expect(findings).toContainEqual({
      checkId: "core/doctor/gateway-health",
      severity: "warning",
      message: "Gateway status could not be inspected: remote gateway did not answer",
      path: "gateway.remote.url",
      target: "wss://***:***@gateway.example.test/rpc?token=***&safe=value",
      fixHint: "Verify the remote Gateway URL, network path, TLS settings, and credentials.",
    });
    expect(JSON.stringify(findings)).not.toContain("user:pass");
    expect(JSON.stringify(findings)).not.toContain("token=secret");
  });

  it("reports missing local gateway daemon service", async () => {
    mocks.readGatewayServiceState.mockResolvedValueOnce({
      installed: false,
      loadState: { status: "not-loaded" },
      running: false,
      env: {},
      command: null,
    });

    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service is not installed.",
      path: "gateway.mode",
      target: "openclaw-gateway",
      fixHint: "Run `openclaw doctor --fix` or `openclaw gateway install` to install it.",
    });
  });

  it("skips daemon findings for remote gateway mode", async () => {
    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "remote" } } }),
    ).resolves.toEqual([]);

    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
  });

  it("skips host-service findings for an externally managed container gateway", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);

    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
    ).resolves.toEqual([]);

    expect(mocks.resolveGatewayService).not.toHaveBeenCalled();
    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
  });
});

describe("doctor provider catalog projection checks", () => {
  beforeEach(() => {
    mocks.resolvePluginProvidersCore.mockReset().mockReturnValue([]);
  });

  it("reports provider catalog rows that fail unified text projection", async () => {
    const providers = Object.defineProperty(
      {
        healthy: {
          api: "openai-completions" as const,
          baseUrl: "https://healthy.test/v1",
          models: [{ id: "healthy-model", name: "Healthy Model", maxTokens: 1 }],
        },
      },
      "broken",
      {
        enumerable: true,
        get() {
          throw new Error("provider catalog entry read failed");
        },
      },
    );
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({ providers }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual({
      checkId: "core/doctor/provider-catalog-projection",
      severity: "error",
      message: "Provider catalog broken entry cannot be read during doctor validation.",
      path: "plugins.entries.mockplugin",
      target: "broken",
      requirement: "provider catalog entry read failed",
      fixHint:
        "Fix the plugin provider catalog hook or disable the plugin, then rerun doctor before relying on model discovery.",
    });
  });

  it("loads full provider registrations without selecting a default workspace", async () => {
    const cfg = { agents: { list: [{ id: "alpha", default: true }, { id: "beta" }] } };
    await collectProviderCatalogProjectionFindings(cfg);

    expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledWith(
      expect.not.objectContaining({
        discoveryEntriesOnly: true,
      }),
    );
    expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: undefined }),
    );
  });

  it("reports provider catalog model rows with invalid ids", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ name: "Missing ID" }],
              },
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("reports whitespace-only provider catalog model ids", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: "   " }],
              },
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("reports provider catalog model rows with invalid names", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: {
              api: "openai-completions" as const,
              baseUrl: "https://mockplugin.test/v1",
              models: [{ id: "mock-model", name: { label: "Mock" } }],
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model name.",
        requirement: "model name must be a string when present",
      }),
    );
  });

  it("reports provider catalog model lists with invalid shapes", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: {
              api: "openai-completions" as const,
              baseUrl: "https://mockplugin.test/v1",
              models: {},
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin models value is invalid during doctor validation.",
        requirement: "models must be an array",
      }),
    );
  });

  it("reports provider catalog model lists with invalid iterators", async () => {
    const models = [{ id: "mock-model" }];
    Object.defineProperty(models, Symbol.iterator, {
      value: () => {
        throw new Error("model iterator failed");
      },
    });
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: {
              api: "openai-completions" as const,
              baseUrl: "https://mockplugin.test/v1",
              models,
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message:
          "Provider catalog mockplugin model rows cannot be enumerated during doctor validation.",
        requirement: "model iterator failed",
      }),
    );
  });

  it("reports provider catalog results without provider containers", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({ providers: undefined }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin result is invalid during doctor validation.",
        requirement: "result must include provider or providers object",
      }),
    );
  });

  it("reports invalid multi-provider catalog keys", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              " ": {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: "mock-model" }],
              },
            },
          }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin provider key is invalid during doctor validation.",
        requirement: "provider key must be a non-empty trimmed string",
      }),
    );
  });

  it("reports falsy non-empty provider catalog results", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => false as never,
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin result is invalid during doctor validation.",
        requirement: "result must be an object",
      }),
    );
  });

  it("reports invalid provider catalog orders without aborting doctor", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "middle" as never,
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: " " }],
              },
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin order is invalid during doctor validation.",
        requirement: "order must be simple, profile, paired, or late",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("validates static catalog rows when live catalog order access fails", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        get catalog() {
          throw new Error("live catalog order failed");
        },
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: " " }],
              },
            },
          }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("reports static catalog hook access failures without aborting doctor", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          get run() {
            throw new Error("run getter failed");
          },
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message:
          "Provider catalog mockplugin static catalog hook cannot be read during doctor validation.",
        requirement: "run getter failed",
      }),
    );
  });

  it("reports static catalog hooks with non-function run values", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: "not-callable",
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message:
          "Provider catalog mockplugin static catalog hook is invalid during doctor validation.",
        requirement: "static catalog run must be a function",
      }),
    );
  });

  it("reports revoked provider catalog result proxies without crashing doctor", async () => {
    const { proxy, revoke } = Proxy.revocable(
      {
        providers: {},
      },
      {},
    );
    revoke();
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          // Awaiting a promise resolved with a proxy reads "then", so revoked
          // catalog results fail at the hook boundary before result key checks.
          run: async () => proxy,
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin failed during doctor validation.",
        requirement: "Cannot perform 'get' on a proxy that has been revoked",
      }),
    );
  });

  it("reports present but invalid single-provider catalog branches", async () => {
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: undefined,
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: "mock-model" }],
              },
            },
          }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin provider value is invalid during doctor validation.",
        requirement: "provider must be an object",
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
