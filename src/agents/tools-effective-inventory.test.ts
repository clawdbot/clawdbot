/**
 * Regression coverage for effective tool inventory resolution.
 * Verifies grouped tool sources, plugin registry inputs, and session-context filters.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { createOpenClawCodingTools } from "./agent-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

type TestPluginMeta = Record<
  string,
  { pluginId: string; mcp?: { serverName: string } } | undefined
>;

function mockTool(params: {
  name: string;
  label: string;
  description: string;
  displaySummary?: string;
  parameters?: unknown;
}): AnyAgentTool {
  return {
    ...params,
    parameters: Object.hasOwn(params, "parameters")
      ? params.parameters
      : { type: "object", properties: {} },
    execute: async () => ({ text: params.description }),
  } as unknown as AnyAgentTool;
}

const effectiveInventoryState = vi.hoisted(() => ({
  tools: [
    mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
    mockTool({ name: "docs_lookup", label: "Docs Lookup", description: "Search docs" }),
  ] as AnyAgentTool[],
  pluginMeta: {} as TestPluginMeta,
  channelMeta: {} as Record<string, { channelId: string } | undefined>,
  effectivePolicy: {} as { profile?: string; providerProfile?: string },
  normalizeToolsMock: vi.fn((options: { tools: AnyAgentTool[] }) => options.tools),
  staticCatalogModelMock: vi.fn((_options: unknown) => undefined as unknown),
  dynamicModelMock: vi.fn((_options: unknown) => undefined as unknown),
  normalizeTransportMock: vi.fn((_options: unknown) => undefined as unknown),
  createToolsMock: vi.fn<typeof createOpenClawCodingTools>(
    (_options) =>
      [
        mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
        mockTool({ name: "docs_lookup", label: "Docs Lookup", description: "Search docs" }),
      ] as AnyAgentTool[],
  ),
}));

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
    resolveAgentDir: () => "/tmp/agents/main/agent",
  };
});

vi.mock("./agent-tools.js", () => ({
  createOpenClawCodingTools: (options?: Parameters<typeof createOpenClawCodingTools>[0]) =>
    effectiveInventoryState.createToolsMock(options),
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: (tool: { name: string }) => effectiveInventoryState.pluginMeta[tool.name],
  buildPluginToolMetadataKey: (pluginId: string, toolName: string) =>
    JSON.stringify([pluginId, toolName]),
}));

vi.mock("./channel-tools.js", () => ({
  getChannelAgentToolMeta: (tool: { name: string }) =>
    effectiveInventoryState.channelMeta[tool.name],
}));

vi.mock("./agent-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: () => effectiveInventoryState.effectivePolicy,
}));

vi.mock("./runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: (options: { tools: AnyAgentTool[] }) =>
    effectiveInventoryState.normalizeToolsMock(options),
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  resolveBundledStaticCatalogModel: (options: unknown) =>
    effectiveInventoryState.staticCatalogModelMock(options),
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModel: (
    provider: unknown,
    modelId: unknown,
    agentDir: unknown,
    cfg: unknown,
    options: unknown,
  ) =>
    ({
      model: effectiveInventoryState.dynamicModelMock({
        provider,
        modelId,
        agentDir,
        cfg,
        options,
      }),
    }) as unknown,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderTransportWithPlugin: (options: unknown) =>
    effectiveInventoryState.normalizeTransportMock(options),
}));

let resolveEffectiveToolInventory: typeof import("./tools-effective-inventory.js").resolveEffectiveToolInventory;

async function loadHarness(options?: {
  tools?: AnyAgentTool[];
  createToolsMock?: typeof effectiveInventoryState.createToolsMock;
  pluginMeta?: TestPluginMeta;
  channelMeta?: Record<string, { channelId: string } | undefined>;
  effectivePolicy?: { profile?: string; providerProfile?: string };
  normalizeToolsMock?: typeof effectiveInventoryState.normalizeToolsMock;
}) {
  effectiveInventoryState.tools = options?.tools ?? [
    mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
    mockTool({ name: "docs_lookup", label: "Docs Lookup", description: "Search docs" }),
  ];
  effectiveInventoryState.pluginMeta = options?.pluginMeta ?? {};
  effectiveInventoryState.channelMeta = options?.channelMeta ?? {};
  effectiveInventoryState.effectivePolicy = options?.effectivePolicy ?? {};
  effectiveInventoryState.normalizeToolsMock =
    options?.normalizeToolsMock ?? vi.fn((normalizeOptions) => normalizeOptions.tools);
  effectiveInventoryState.staticCatalogModelMock = vi.fn((_options: unknown) => undefined);
  effectiveInventoryState.dynamicModelMock = vi.fn((_options: unknown) => undefined);
  effectiveInventoryState.normalizeTransportMock = vi.fn((_options: unknown) => undefined);
  effectiveInventoryState.createToolsMock =
    options?.createToolsMock ??
    vi.fn<typeof createOpenClawCodingTools>((_options) => effectiveInventoryState.tools);
  return {
    resolveEffectiveToolInventory,
    createToolsMock: effectiveInventoryState.createToolsMock,
  };
}

describe("resolveEffectiveToolInventory", () => {
  beforeAll(async () => {
    ({ resolveEffectiveToolInventory } = await import("./tools-effective-inventory.js"));
  });

  beforeEach(() => {
    effectiveInventoryState.tools = [
      mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
      mockTool({ name: "docs_lookup", label: "Docs Lookup", description: "Search docs" }),
    ];
    effectiveInventoryState.pluginMeta = {};
    effectiveInventoryState.channelMeta = {};
    effectiveInventoryState.effectivePolicy = {};
    effectiveInventoryState.normalizeToolsMock = vi.fn((options) => options.tools);
    effectiveInventoryState.staticCatalogModelMock = vi.fn((_options: unknown) => undefined);
    effectiveInventoryState.dynamicModelMock = vi.fn((_options: unknown) => undefined);
    effectiveInventoryState.normalizeTransportMock = vi.fn((_options: unknown) => undefined);
    effectiveInventoryState.createToolsMock = vi.fn<typeof createOpenClawCodingTools>(
      (_options) => effectiveInventoryState.tools,
    );
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("groups core, plugin, and channel tools from the effective runtime set", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal11 } =
      await loadHarness({
        tools: [
          mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
          mockTool({ name: "docs_lookup", label: "Docs Lookup", description: "Search docs" }),
          mockTool({
            name: "message_actions",
            label: "Message Actions",
            description: "Act on messages",
          }),
        ],
        pluginMeta: { docs_lookup: { pluginId: "docs" } },
        channelMeta: { message_actions: { channelId: "telegram" } },
      });

    const result = resolveEffectiveToolInventoryLocal11({ cfg: {} });

    expect(result).toEqual({
      agentId: "main",
      profile: "full",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "exec",
              label: "Exec",
              description: "Run shell commands",
              rawDescription: "Run shell commands",
              source: "core",
            },
          ],
        },
        {
          id: "plugin",
          label: "Connected tools",
          source: "plugin",
          tools: [
            {
              id: "docs_lookup",
              label: "Docs Lookup",
              description: "Search docs",
              rawDescription: "Search docs",
              source: "plugin",
              pluginId: "docs",
            },
          ],
        },
        {
          id: "channel",
          label: "Channel tools",
          source: "channel",
          tools: [
            {
              id: "message_actions",
              label: "Message Actions",
              description: "Act on messages",
              rawDescription: "Act on messages",
              source: "channel",
              channelId: "telegram",
            },
          ],
        },
      ],
    });
  });

  it("groups bundled MCP tools separately from generic plugin tools", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal10 } =
      await loadHarness({
        tools: [
          mockTool({ name: "reproProbe__probe_tool", label: "Probe", description: "Probe MCP" }),
        ],
        pluginMeta: { reproProbe__probe_tool: { pluginId: "bundle-mcp" } },
      });

    const result = resolveEffectiveToolInventoryLocal10({ cfg: {} });

    expect(result.groups).toEqual([
      {
        id: "mcp",
        label: "MCP server tools",
        source: "mcp",
        tools: [
          {
            id: "reproProbe__probe_tool",
            label: "Probe",
            description: "Probe MCP",
            rawDescription: "Probe MCP",
            source: "mcp",
            pluginId: "bundle-mcp",
          },
        ],
      },
    ]);
  });

  it("groups plugin tools with MCP metadata separately from generic plugin tools", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal11 } =
      await loadHarness({
        tools: [
          mockTool({ name: "remote_echo", label: "Remote Echo", description: "Probe node MCP" }),
        ],
        pluginMeta: {
          remote_echo: {
            pluginId: "remote-demo",
            mcp: { serverName: "remote-demo" },
          },
        },
      });

    const result = resolveEffectiveToolInventoryLocal11({ cfg: {} });

    expect(result.groups).toEqual([
      {
        id: "mcp",
        label: "MCP server tools",
        source: "mcp",
        tools: [
          {
            id: "remote_echo",
            label: "Remote Echo",
            description: "Probe node MCP",
            rawDescription: "Probe node MCP",
            source: "mcp",
            pluginId: "remote-demo",
          },
        ],
      },
    ]);
  });

  it("disambiguates duplicate labels with source ids", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal9 } =
      await loadHarness({
        tools: [
          mockTool({ name: "docs_lookup", label: "Lookup", description: "Search docs" }),
          mockTool({ name: "jira_lookup", label: "Lookup", description: "Search Jira" }),
        ],
        pluginMeta: {
          docs_lookup: { pluginId: "docs" },
          jira_lookup: { pluginId: "jira" },
        },
      });

    const result = resolveEffectiveToolInventoryLocal9({ cfg: {} });
    const labels = result.groups.flatMap((group) => group.tools.map((tool) => tool.label));

    expect(labels).toEqual(["Lookup (docs)", "Lookup (jira)"]);
  });

  it("projects plugin tool metadata into the effective inventory", async () => {
    const registry = createEmptyPluginRegistry();
    registry.toolMetadata = [
      {
        pluginId: "docs",
        pluginName: "Docs",
        source: "fixture",
        metadata: {
          toolName: "docs_lookup",
          displayName: "Docs Search",
          description: "Curated docs lookup.",
          risk: "low",
          tags: ["docs", "fixture"],
        },
      },
    ];
    setActivePluginRegistry(registry);
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal8 } =
      await loadHarness({
        tools: [mockTool({ name: "docs_lookup", label: "Lookup", description: "Search docs" })],
        pluginMeta: { docs_lookup: { pluginId: "docs" } },
      });

    const result = resolveEffectiveToolInventoryLocal8({ cfg: {} });

    expect(result.groups[0]?.tools[0]).toEqual({
      id: "docs_lookup",
      label: "Docs Search",
      description: "Curated docs lookup.",
      rawDescription: "Curated docs lookup.",
      source: "plugin",
      pluginId: "docs",
      risk: "low",
      tags: ["docs", "fixture"],
    });
  });

  it("quarantines tools with schemas that cannot be projected to the model runtime", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal7 } =
      await loadHarness({
        tools: [
          mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
          mockTool({
            name: "fuzzplugin_move_angles",
            label: "Fuzzplugin Move Angles",
            description: "Move robot joints",
            parameters: {
              type: "object",
              properties: {
                target: { $dynamicRef: "#target" },
              },
            },
          }),
        ],
        pluginMeta: { fuzzplugin_move_angles: { pluginId: "fuzzplugin" } },
      });

    const result = resolveEffectiveToolInventoryLocal7({ cfg: {} });

    expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual(["exec"]);
    expect(result.notices).toEqual([
      {
        id: "unsupported-tool-schema:fuzzplugin_move_angles",
        severity: "warning",
        message:
          'Tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has an unsupported runtime input schema (fuzzplugin_move_angles.parameters.properties.target.$dynamicRef) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.',
      },
    ]);
  });

  it("preserves plugin ownership for pre-normalization schema quarantines", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal12 } =
      await loadHarness({
        tools: [
          mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
          mockTool({
            name: "fuzzplugin_move_angles",
            label: "Fuzzplugin Move Angles",
            description: "Move fixture joints",
            parameters: { type: "array", items: { type: "number" } },
          }),
        ],
        pluginMeta: { fuzzplugin_move_angles: { pluginId: "fuzzplugin" } },
      });

    const result = resolveEffectiveToolInventoryLocal12({ cfg: {} });

    expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual(["exec"]);
    expect(result.notices).toEqual([
      {
        id: "unsupported-tool-schema:fuzzplugin_move_angles",
        severity: "warning",
        message:
          'Tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has an unsupported runtime input schema (fuzzplugin_move_angles.parameters.type must be "object") and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.',
      },
    ]);
  });

  it("reports unreadable inventory tool entries without crashing", async () => {
    const healthy = mockTool({ name: "exec", label: "Exec", description: "Run shell commands" });
    const tools = new Proxy([healthy] as AnyAgentTool[], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("fuzzplugin inventory entry getter exploded");
        }
        if (property === "1") {
          return healthy;
        }
        if (property === "length") {
          return 2;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal13 } =
      await loadHarness({ tools });

    const result = resolveEffectiveToolInventoryLocal13({ cfg: {} });

    expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual(["exec"]);
    expect(result.notices).toEqual([
      {
        id: "unsupported-tool-schema:tool[0]",
        severity: "warning",
        message:
          'Tool "tool[0]" has an unsupported runtime input schema (tool[0] is unreadable) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.',
      },
    ]);
  });

  it("validates normalized runtime schemas before quarantining effective tools", async () => {
    const normalizeToolsMock = vi.fn((options: { tools: AnyAgentTool[] }) =>
      options.tools.map((entry) =>
        entry.name === "parameter_free"
          ? ({
              ...entry,
              parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
            } as AnyAgentTool)
          : entry,
      ),
    );
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal6 } =
      await loadHarness({
        tools: [
          mockTool({
            name: "parameter_free",
            label: "Parameter Free",
            description: "Runtime-normalized tool",
            parameters: undefined,
          }),
        ],
        pluginMeta: { parameter_free: { pluginId: "normalized-plugin" } },
        normalizeToolsMock,
      });

    const result = resolveEffectiveToolInventoryLocal6({
      cfg: {},
      modelProvider: "openai",
      modelId: "gpt-test",
      modelApi: "openai-responses",
      runtimeModel: {
        id: "gpt-test",
        name: "GPT Test",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      } as never,
    });

    expect(result.groups[0]?.tools[0]).toMatchObject({
      id: "parameter_free",
      source: "plugin",
      pluginId: "normalized-plugin",
    });
    expect(result.notices).toBeUndefined();
    expect(normalizeToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-test",
        modelApi: "openai-responses",
        model: expect.objectContaining({
          id: "gpt-test",
          api: "openai-responses",
          provider: "openai",
        }),
      }),
    );
  });

  it("overlays provider transport config on bundled static model context", async () => {
    const normalizeToolsMock = vi.fn((options: { tools: AnyAgentTool[] }) => options.tools);
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal5 } =
      await loadHarness({
        tools: [
          mockTool({
            name: "exec",
            label: "Exec",
            description: "Run shell commands",
          }),
        ],
        normalizeToolsMock,
      });
    effectiveInventoryState.staticCatalogModelMock.mockReturnValue({
      id: "gpt-test",
      name: "GPT Test",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    resolveEffectiveToolInventoryLocal5({
      cfg: {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "https://proxy.example.com/v1",
            },
          },
        },
      } as never,
      modelProvider: "openai",
      modelId: "gpt-test",
    });

    expect(normalizeToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-completions",
        model: expect.objectContaining({
          api: "openai-completions",
          baseUrl: "https://proxy.example.com/v1",
        }),
      }),
    );
    expect(effectiveInventoryState.normalizeTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-test",
        workspaceDir: "/tmp/workspace-main",
        context: expect.objectContaining({
          config: expect.any(Object),
          modelId: "gpt-test",
          workspaceDir: "/tmp/workspace-main",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://proxy.example.com/v1",
        }),
      }),
    );
    expect(effectiveInventoryState.createToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-completions",
      }),
    );
  });

  it("applies provider transport normalization to bundled static model context", async () => {
    const normalizeToolsMock = vi.fn((options: { tools: AnyAgentTool[] }) => options.tools);
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal4 } =
      await loadHarness({
        tools: [
          mockTool({
            name: "exec",
            label: "Exec",
            description: "Run shell commands",
          }),
        ],
        normalizeToolsMock,
      });
    effectiveInventoryState.staticCatalogModelMock.mockReturnValue({
      id: "gpt-test",
      name: "GPT Test",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    effectiveInventoryState.normalizeTransportMock.mockReturnValue({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    resolveEffectiveToolInventoryLocal4({
      cfg: {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "https://proxy.example.com/v1",
            },
          },
        },
      } as never,
      modelProvider: "openai",
      modelId: "gpt-test",
    });

    expect(normalizeToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-responses",
        model: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
      }),
    );
    expect(effectiveInventoryState.normalizeTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace-main",
        context: expect.objectContaining({
          config: expect.any(Object),
          workspaceDir: "/tmp/workspace-main",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://proxy.example.com/v1",
        }),
      }),
    );
    expect(effectiveInventoryState.createToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-responses",
      }),
    );
  });

  it("normalizes configured model context when the model omits api", async () => {
    const normalizeToolsMock = vi.fn((options: { tools: AnyAgentTool[] }) => options.tools);
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal3 } =
      await loadHarness({
        tools: [
          mockTool({
            name: "exec",
            label: "Exec",
            description: "Run shell commands",
          }),
        ],
        normalizeToolsMock,
      });
    effectiveInventoryState.normalizeTransportMock.mockReturnValue({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });

    resolveEffectiveToolInventoryLocal3({
      cfg: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.5-codex",
                  name: "GPT-5.5 Codex",
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      } as never,
      modelProvider: "openai",
      modelId: "gpt-5.5-codex",
    });

    expect(effectiveInventoryState.normalizeTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace-main",
        context: expect.objectContaining({
          config: expect.any(Object),
          workspaceDir: "/tmp/workspace-main",
          provider: "openai",
          api: "openai-responses",
          baseUrl: undefined,
        }),
      }),
    );
    expect(effectiveInventoryState.createToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-chatgpt-responses",
      }),
    );
    expect(normalizeToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-chatgpt-responses",
        model: expect.objectContaining({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      }),
    );
  });

  it("preserves bundled static transport when configured model row omits api", async () => {
    const normalizeToolsMock = vi.fn((options: { tools: AnyAgentTool[] }) => options.tools);
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal2 } =
      await loadHarness({
        tools: [
          mockTool({
            name: "exec",
            label: "Exec",
            description: "Run shell commands",
          }),
        ],
        normalizeToolsMock,
      });
    effectiveInventoryState.staticCatalogModelMock.mockReturnValue({
      id: "claude-sonnet-test",
      name: "Bundled Claude Sonnet",
      provider: "github-copilot",
      api: "anthropic-messages",
      baseUrl: "https://api.githubcopilot.com",
    });

    resolveEffectiveToolInventoryLocal2({
      cfg: {
        models: {
          providers: {
            "github-copilot": {
              models: [
                {
                  id: "claude-sonnet-test",
                  name: "Configured Claude Sonnet",
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      } as never,
      modelProvider: "github-copilot",
      modelId: "claude-sonnet-test",
    });

    expect(effectiveInventoryState.createToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "anthropic-messages",
      }),
    );
    expect(normalizeToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "anthropic-messages",
        model: expect.objectContaining({
          name: "Configured Claude Sonnet",
          api: "anthropic-messages",
          baseUrl: "https://api.githubcopilot.com",
        }),
      }),
    );
  });

  it("uses dynamic provider model context before quarantining runtime-normalized tools", async () => {
    const normalizeToolsMock = vi.fn((options: { tools: AnyAgentTool[]; modelApi?: string }) =>
      options.tools.map((entry) =>
        entry.name === "parameter_free" && options.modelApi === "openai-responses"
          ? ({
              ...entry,
              parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
            } as AnyAgentTool)
          : entry,
      ),
    );
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryInner } = await loadHarness(
      {
        tools: [
          mockTool({
            name: "parameter_free",
            label: "Parameter Free",
            description: "Runtime-normalized tool",
            parameters: undefined,
          }),
        ],
        pluginMeta: { parameter_free: { pluginId: "normalized-plugin" } },
        normalizeToolsMock,
      },
    );
    effectiveInventoryState.dynamicModelMock.mockReturnValue({
      id: "chat-latest",
      name: "chat-latest",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = resolveEffectiveToolInventoryInner({
      cfg: {},
      modelProvider: "openai",
      modelId: "chat-latest",
    });

    expect(result.groups[0]?.tools[0]).toMatchObject({
      id: "parameter_free",
      source: "plugin",
      pluginId: "normalized-plugin",
    });
    expect(result.notices).toBeUndefined();
    expect(effectiveInventoryState.dynamicModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "chat-latest",
        agentDir: "/tmp/agents/main/agent",
        options: expect.objectContaining({ workspaceDir: "/tmp/workspace-main" }),
      }),
    );
    expect(normalizeToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "chat-latest",
        modelApi: "openai-responses",
        model: expect.objectContaining({
          id: "chat-latest",
          api: "openai-responses",
          provider: "openai",
        }),
      }),
    );
  });

  it("does not let one plugin project metadata onto another plugin tool", async () => {
    const registry = createEmptyPluginRegistry();
    registry.toolMetadata = [
      {
        pluginId: "spoofing-plugin",
        pluginName: "Spoofing Plugin",
        source: "fixture",
        metadata: {
          toolName: "docs_lookup",
          displayName: "Spoofed Docs Search",
          risk: "high",
        },
      },
    ];
    setActivePluginRegistry(registry);
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryScoped } =
      await loadHarness({
        tools: [mockTool({ name: "docs_lookup", label: "Lookup", description: "Search docs" })],
        pluginMeta: { docs_lookup: { pluginId: "docs" } },
      });

    const result = resolveEffectiveToolInventoryScoped({ cfg: {} });

    expect(result.groups[0]?.tools[0]).toEqual({
      id: "docs_lookup",
      label: "Lookup",
      description: "Search docs",
      rawDescription: "Search docs",
      source: "plugin",
      pluginId: "docs",
    });
  });

  it("prefers displaySummary over raw description", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryItem } = await loadHarness({
      tools: [
        mockTool({
          name: "cron",
          label: "Cron",
          displaySummary: "Schedule and manage cron jobs.",
          description: "Long raw description\n\nACTIONS:\n- status",
        }),
      ],
    });

    const result = resolveEffectiveToolInventoryItem({ cfg: {} });

    expect(result.groups[0]?.tools[0]).toEqual({
      id: "cron",
      label: "Cron",
      description: "Schedule and manage cron jobs.",
      rawDescription: "Long raw description\n\nACTIONS:\n- status",
      source: "core",
    });
  });

  it("falls back to a sanitized summary for multi-line raw descriptions", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryCandidate } =
      await loadHarness({
        tools: [
          mockTool({
            name: "cron",
            label: "Cron",
            description:
              'Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check cron scheduler status\nJOB SCHEMA:\n{ ... }',
          }),
        ],
      });

    const result = resolveEffectiveToolInventoryCandidate({ cfg: {} });

    const description = result.groups[0]?.tools[0]?.description ?? "";
    expect(description).toContain(
      "Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.",
    );
    expect(description).toContain("Use this for reminders");
    expect(description.endsWith("...")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(120);
    expect(result.groups[0]?.tools[0]?.rawDescription).toContain("ACTIONS:");
  });

  it("includes the resolved tool profile", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryEntry } = await loadHarness(
      {
        tools: [mockTool({ name: "exec", label: "Exec", description: "Run shell commands" })],
        effectivePolicy: { profile: "minimal", providerProfile: "coding" },
      },
    );

    const result = resolveEffectiveToolInventoryEntry({ cfg: {} });

    expect(result.profile).toBe("coding");
  });

  it("adds an actionable notice when configured browser is filtered by the tool profile", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryResult } =
      await loadHarness({
        tools: [
          mockTool({ name: "web_fetch", label: "Web Fetch", description: "Fetch web content" }),
        ],
        effectivePolicy: { profile: "coding" },
      });

    const result = resolveEffectiveToolInventoryResult({
      cfg: {
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as never,
    });

    expect(result.notices).toEqual([
      {
        id: "browser-filtered-by-profile",
        severity: "info",
        message:
          'Browser is configured, but the current tool profile does not include the browser tool. Add tools.alsoAllow: ["browser"] or agents.entries.*.tools.alsoAllow: ["browser"]; tools.subagents.tools.allow alone cannot add it back after profile filtering.',
      },
    ]);
  });

  it("does not add a browser profile notice when browser is already available", async () => {
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryValue } = await loadHarness(
      {
        tools: [
          mockTool({ name: "browser", label: "Browser", description: "Control browser" }),
          mockTool({ name: "web_fetch", label: "Web Fetch", description: "Fetch web content" }),
        ],
        effectivePolicy: { profile: "coding" },
      },
    );

    const result = resolveEffectiveToolInventoryValue({
      cfg: {
        browser: { enabled: true },
        plugins: { entries: { browser: { enabled: true } } },
      } as never,
    });

    expect(result.notices).toBeUndefined();
  });

  it("passes resolved model compat into effective tool creation", async () => {
    const createToolsMock = vi.fn<typeof createOpenClawCodingTools>(() => [
      mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
    ]);
    const { resolveEffectiveToolInventory: resolveEffectiveToolInventoryLocal } = await loadHarness(
      {
        createToolsMock,
      },
    );

    resolveEffectiveToolInventoryLocal({
      cfg: {
        models: {
          providers: {
            xai: {
              baseUrl: "https://api.x.ai/v1",
              models: [
                {
                  id: "grok-test",
                  name: "Grok Test",
                  api: "openai-completions",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                  compat: { supportsTools: true },
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/agents/main/agent",
      modelProvider: "xai",
      modelId: "grok-test",
    });

    expect(createToolsMock).toHaveBeenCalledTimes(1);
    const createToolsOptions = createToolsMock.mock.calls.at(0)?.[0];
    expect(createToolsOptions?.allowGatewaySubagentBinding).toBe(true);
    expect(createToolsOptions?.modelCompat).toEqual({ supportsTools: true });
    expect(createToolsOptions?.modelApi).toBe("openai-completions");
  });
});
