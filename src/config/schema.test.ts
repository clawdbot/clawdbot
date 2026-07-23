import { SENSITIVE_URL_HINT_TAG } from "@openclaw/net-policy/redact-sensitive-url";
// Covers canonical config schema defaults, validation, and sensitive redaction.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it } from "vitest";
import { buildConfigSchema, lookupConfigSchema } from "./schema.js";
import { applyDerivedTags } from "./schema.tags.js";
import { applyResolvedConfigTierHints } from "./schema.tiers.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("config schema", () => {
  type SchemaInput = NonNullable<Parameters<typeof buildConfigSchema>[0]>;
  let baseSchema: ReturnType<typeof buildConfigSchema>;
  let pluginUiHintInput: SchemaInput;
  let tokenHintInput: SchemaInput;
  let mergedSchemaInput: SchemaInput;
  let heartbeatChannelInput: SchemaInput;
  let cachedMergeInput: SchemaInput;

  beforeAll(() => {
    baseSchema = buildConfigSchema();
    pluginUiHintInput = {
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          description: "Outbound voice calls",
          configUiHints: {
            provider: { label: "Provider" },
            "twilio.authToken": { label: "Auth Token", sensitive: true },
          },
        },
      ],
    };
    tokenHintInput = {
      plugins: [
        {
          id: "voice-call",
          configUiHints: {
            tokens: { label: "Tokens", sensitive: false },
          },
        },
      ],
    };
    mergedSchemaInput = {
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          configSchema: {
            type: "object",
            properties: {
              provider: { type: "string" },
            },
          },
        },
      ],
      channels: [
        {
          id: "matrix",
          label: "Matrix",
          configSchema: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
            },
          },
        },
      ],
    };
    heartbeatChannelInput = {
      channels: [
        {
          id: "imessage",
          label: "iMessage",
          configSchema: { type: "object" },
        },
      ],
    };
    cachedMergeInput = {
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          configSchema: { type: "object", properties: { provider: { type: "string" } } },
        },
      ],
      channels: [
        {
          id: "matrix",
          label: "Matrix",
          configSchema: { type: "object", properties: { accessToken: { type: "string" } } },
        },
      ],
    };
  });

  it("exports schema + hints", () => {
    const res = baseSchema;
    const schema = res.schema as { properties?: Record<string, unknown> };
    const gatewaySchema = schema.properties?.gateway as
      | { properties?: Record<string, unknown> }
      | undefined;
    const gatewayPortSchema = gatewaySchema?.properties?.port as
      | { title?: string; description?: string }
      | undefined;
    expect(schema.properties).toHaveProperty("gateway");
    expect(schema.properties).toHaveProperty("agents");
    expect(schema.properties).toHaveProperty("acp");
    expect(schema.properties?.$schema).toBeUndefined();
    expect(gatewayPortSchema?.title).toBe("Gateway Port");
    expect(gatewayPortSchema?.description).toContain("TCP port used by the gateway listener");
    expect(res.uiHints.gateway?.label).toBe("Gateway");
    expect(res.uiHints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(res.uiHints["security.installPolicy.exec.env.*"]?.sensitive).toBe(true);
    const groupPolicyLabel = res.uiHints["channels.defaults.groupPolicy"]?.label;
    expect(groupPolicyLabel).toBeTypeOf("string");
    expect(groupPolicyLabel?.trim().length).toBeGreaterThan(0);
    expect(res.uiHints["mcp.servers.*.headers.*"]?.sensitive).toBe(true);
    expect(res.uiHints["mcp.servers.*.env.*"]?.sensitive).toBe(true);
    expect(res.uiHints["mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
    expect(res.uiHints["nodeHost.mcp.servers.*.headers.*"]?.sensitive).toBe(true);
    expect(res.uiHints["nodeHost.mcp.servers.*.env.*"]?.sensitive).toBe(true);
    expect(res.uiHints["nodeHost.mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
    expect(res.uiHints["models.providers.*.baseUrl"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
    const phonePresentationPaths = [
      "channels.sms.fromNumber",
      "channels.sms.defaultTo",
      "channels.sms.allowFrom",
      "channels.sms.accounts.*.fromNumber",
      "channels.sms.accounts.*.defaultTo",
      "channels.sms.accounts.*.allowFrom.*",
      "channels.signal.account",
      "channels.signal.allowFrom",
      "channels.signal.defaultTo",
      "channels.signal.groupAllowFrom",
      "channels.signal.reactionAllowlist",
      "channels.signal.accounts.*.account",
      "channels.signal.accounts.*.allowFrom.*",
      "channels.signal.accounts.*.defaultTo",
      "channels.signal.accounts.*.groupAllowFrom.*",
      "channels.signal.accounts.*.reactionAllowlist.*",
      "channels.whatsapp.allowFrom",
      "channels.whatsapp.defaultTo",
      "channels.whatsapp.groupAllowFrom",
      "channels.whatsapp.accounts.*.allowFrom.*",
      "channels.whatsapp.accounts.*.defaultTo",
      "channels.whatsapp.accounts.*.groupAllowFrom.*",
      "channels.imessage.allowFrom",
      "channels.imessage.defaultTo",
      "channels.imessage.groupAllowFrom",
      "channels.imessage.accounts.*.allowFrom.*",
      "channels.imessage.accounts.*.defaultTo",
      "channels.imessage.accounts.*.groupAllowFrom.*",
    ];
    for (const path of phonePresentationPaths) {
      expect(res.uiHints[path]?.presentation, path).toBe("phone-number");
    }
    expect(res.uiHints["channels.sms.authToken"]?.presentation).toBeUndefined();
    expect(res.uiHints["channels.signal.configPath"]?.presentation).toBeUndefined();
    expect(res.uiHints["proxy.tls.caFile"]?.tags).toEqual(
      expect.arrayContaining(["security", "network", "storage"]),
    );
    expect(res.version).toBeTypeOf("string");
    expect(res.version.trim().length).toBeGreaterThan(0);
    expect(res.generatedAt).toBeTypeOf("string");
    expect(res.generatedAt.trim().length).toBeGreaterThan(0);
  });

  it("accepts qmd query rerank override", () => {
    const result = OpenClawSchema.safeParse({
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "query",
          rerank: false,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects retired status reaction emoji overrides", () => {
    const result = OpenClawSchema.safeParse({
      messages: {
        statusReactions: {
          emojis: {
            queued: "👁️",
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("includes MCP SSE header schema under mcp.servers entries", () => {
    const schema = baseSchema.schema as {
      properties?: Record<string, unknown>;
    };
    const mcpNode = schema.properties?.mcp as
      | {
          properties?: Record<string, unknown>;
        }
      | undefined;
    const serversNode = mcpNode?.properties?.servers as
      | {
          additionalProperties?: {
            properties?: Record<string, unknown>;
          };
        }
      | undefined;
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("headers");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("transport");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("enabled");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("requestTimeoutMs");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("connectionTimeoutMs");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("auth");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("oauth");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("sslVerify");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("clientCert");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("toolFilter");
    expect(serversNode?.additionalProperties?.properties).toHaveProperty("codex");
  });

  it("accepts node-host MCP servers with the shared MCP server schema", () => {
    const result = OpenClawSchema.safeParse({
      nodeHost: {
        mcp: {
          servers: {
            local: {
              command: "node",
              args: ["server.mjs"],
              toolFilter: { include: ["read_*"] },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    const invalid = OpenClawSchema.safeParse({
      nodeHost: { mcp: { servers: { broken: { transport: "stdio" } } } },
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]?.message).toBe(
        '"stdio" transport requires a non-empty command',
      );
    }
  });

  it("rejects blank or whitespace-padded node-host MCP server names", () => {
    for (const serverName of ["", "  ", " docs "]) {
      expect(() =>
        OpenClawSchema.parse({
          nodeHost: { mcp: { servers: { [serverName]: { command: "server" } } } },
        }),
      ).toThrow(/MCP server name must be non-empty and must not have surrounding whitespace/);
    }
  });

  it("rejects empty Codex MCP agent scopes", () => {
    expect(() =>
      OpenClawSchema.parse({
        mcp: {
          servers: {
            scoped: {
              url: "https://mcp.example.com/mcp",
              transport: "streamable-http",
              codex: { agents: [] },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      OpenClawSchema.parse({
        mcp: {
          servers: {
            scoped: {
              url: "https://mcp.example.com/mcp",
              transport: "streamable-http",
              codex: { agents: ["  "] },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      OpenClawSchema.parse({
        mcp: {
          servers: {
            scoped: {
              url: "https://mcp.example.com/mcp",
              transport: "streamable-http",
              codex: { agents: ["!!!"] },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("validates MCP OAuth client metadata URLs against the SDK contract", () => {
    expect(() =>
      OpenClawSchema.parse({
        mcp: {
          servers: {
            docs: {
              url: "https://mcp.example.com/mcp",
              transport: "streamable-http",
              auth: "oauth",
              oauth: {
                clientMetadataUrl: "https://client.example.com/openclaw-mcp.json",
              },
            },
          },
        },
      }),
    ).not.toThrow();
    for (const clientMetadataUrl of [
      "http://client.example.com/openclaw-mcp.json",
      "https://client.example.com/",
    ]) {
      expect(() =>
        OpenClawSchema.parse({
          mcp: {
            servers: {
              docs: {
                url: "https://mcp.example.com/mcp",
                transport: "streamable-http",
                auth: "oauth",
                oauth: { clientMetadataUrl },
              },
            },
          },
        }),
      ).toThrow();
    }
  });

  it("accepts MCP OAuth auth profile bindings for refreshable bearer projection", () => {
    expect(() =>
      OpenClawSchema.parse({
        mcp: {
          servers: {
            ducktape: {
              url: "https://agents.ducktape.xyz/mcp",
              transport: "streamable-http",
              auth: "oauth",
              oauth: {
                authProfileId: "ducktape:mcp",
              },
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      OpenClawSchema.parse({
        mcp: {
          servers: {
            ducktape: {
              url: "https://agents.ducktape.xyz/mcp",
              transport: "streamable-http",
              auth: "oauth",
              oauth: {
                authProfileId: "  ",
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("accepts stdio transport for command-bearing MCP servers", () => {
    const result = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          myTool: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            transport: "stdio",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unsupported transport values for MCP servers", () => {
    for (const transport of ["tcp", "websocket", "grpc", ""]) {
      expect(() =>
        OpenClawSchema.parse({
          mcp: {
            servers: {
              bad: {
                url: "https://mcp.example.com/mcp",
                transport,
              },
            },
          },
        }),
      ).toThrow();
    }
  });

  it("rejects stdio transport for URL-only MCP servers (command required)", () => {
    const result = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          bad: {
            url: "https://mcp.example.com/mcp",
            transport: "stdio",
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects stdio transport with whitespace-only command", () => {
    const result = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          bad: {
            command: "   ",
            transport: "stdio",
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("merges plugin ui hints", () => {
    const res = buildConfigSchema(pluginUiHintInput);

    expect(res.uiHints["plugins.entries.voice-call"]?.label).toBe("Voice Call");
    expect(res.uiHints["plugins.entries.voice-call.config"]?.label).toBe("Voice Call Config");
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.label).toBe(
      "Auth Token",
    );
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.sensitive).toBe(true);
  });

  it("does not re-mark existing non-sensitive token-like fields", () => {
    const res = buildConfigSchema(tokenHintInput);

    expect(res.uiHints["plugins.entries.voice-call.config.tokens"]?.sensitive).toBe(false);
  });

  it("merges plugin + channel schemas", () => {
    const res = buildConfigSchema(mergedSchemaInput);

    const schema = res.schema as {
      properties?: Record<string, unknown>;
    };
    const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
    const entriesNode = pluginsNode?.properties as Record<string, unknown> | undefined;
    const entriesProps = entriesNode?.entries as Record<string, unknown> | undefined;
    const entryProps = entriesProps?.properties as Record<string, unknown> | undefined;
    const pluginEntry = entryProps?.["voice-call"] as Record<string, unknown> | undefined;
    const pluginConfig = pluginEntry?.properties as Record<string, unknown> | undefined;
    const pluginConfigSchema = pluginConfig?.config as Record<string, unknown> | undefined;
    const pluginConfigProps = pluginConfigSchema?.properties as Record<string, unknown> | undefined;
    expect(pluginConfigProps).toHaveProperty("provider");

    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelsProps = channelsNode?.properties as Record<string, unknown> | undefined;
    const channelSchema = channelsProps?.matrix as Record<string, unknown> | undefined;
    const channelProps = channelSchema?.properties as Record<string, unknown> | undefined;
    expect(channelProps).toHaveProperty("accessToken");
    const progressPropsFor = (channelId: string) => {
      const channel = channelsProps?.[channelId] as Record<string, unknown> | undefined;
      const properties = channel?.properties as Record<string, unknown> | undefined;
      const streaming = properties?.streaming as Record<string, unknown> | undefined;
      const streamingProperties = streaming?.properties as Record<string, unknown> | undefined;
      const progress = streamingProperties?.progress as Record<string, unknown> | undefined;
      return progress?.properties as Record<string, unknown> | undefined;
    };
    expect(progressPropsFor("slack")).toHaveProperty("nativeTaskCards");
    expect(progressPropsFor("discord")).not.toHaveProperty("nativeTaskCards");
    expect(progressPropsFor("telegram")).not.toHaveProperty("nativeTaskCards");
    expect(progressPropsFor("discord")).toHaveProperty("commentary");
    expect(progressPropsFor("slack")).toHaveProperty("commentary");
    expect(progressPropsFor("telegram")).toHaveProperty("commentary");
    expect(res.uiHints["channels.matrix"]?.label).toBe("Matrix");
    expect(res.uiHints["channels.matrix.accessToken"]?.sensitive).toBe(true);
    expect(res.uiHints["channels.matrix.streaming.progress.label"]?.label).toBe(
      "Matrix Progress Label",
    );
    expect(res.uiHints["channels.slack.streaming.progress.nativeTaskCards"]?.label).toBe(
      "Slack Native Progress Task Cards",
    );
    expect(res.uiHints["channels.discord.streaming.progress.nativeTaskCards"]).toBeUndefined();
    expect(res.uiHints["channels.telegram.streaming.progress.nativeTaskCards"]).toBeUndefined();
    expect(res.uiHints["channels.discord.streaming.progress.toolProgress"]?.label).toBe(
      "Discord Progress Tool Lines",
    );
    expect(res.uiHints["channels.telegram.streaming.progress.commentary"]?.label).toBe(
      "Telegram Progress Commentary",
    );
    expect(res.uiHints["channels.mattermost.streaming.progress.label"]?.label).toBe(
      "Mattermost Progress Label",
    );
  });

  it("omits a single oversized plugin schema from the full schema response", () => {
    const res = buildConfigSchema({
      cache: false,
      plugins: [
        {
          id: "huge",
          name: "Huge",
          configSchema: {
            type: "object",
            properties: {
              huge: {
                type: "string",
                description: `oversized-marker-${"x".repeat(300_000)}`,
              },
            },
          },
        },
      ],
    });

    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("oversized-marker");
    const lookup = lookupConfigSchema(res, "plugins.entries.huge.config");
    expect(lookup?.schema?.type).toBe("object");
    expect(lookup?.schema?.additionalProperties).toBe(true);
    expect(lookup?.schema?.description).toContain("omitted");
  });

  it("omits later plugin schemas after the aggregate extension schema budget is exhausted", () => {
    const res = buildConfigSchema({
      cache: false,
      plugins: Array.from({ length: 40 }, (_, index) => ({
        id: `plugin-${index}`,
        configSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: `schema-${index}-${"x".repeat(60_000)}`,
            },
          },
        },
      })),
    });

    const first = lookupConfigSchema(res, "plugins.entries.plugin-0.config.value");
    const last = lookupConfigSchema(res, "plugins.entries.plugin-39.config");
    expect(first?.schema?.type).toBe("string");
    expect(last?.schema?.type).toBe("object");
    expect(last?.schema?.additionalProperties).toBe(true);
    expect(last?.schema?.description).toContain("omitted");
  });

  it("looks up plugin config paths for slash-delimited plugin ids", () => {
    const res = buildConfigSchema({
      plugins: [
        {
          id: "pack/one",
          name: "Pack One",
          configSchema: {
            type: "object",
            properties: {
              provider: { type: "string" },
            },
          },
        },
      ],
    });

    const lookup = lookupConfigSchema(res, "plugins.entries.pack/one.config");
    expect(lookup?.path).toBe("plugins.entries.pack/one.config");
    expect(lookup?.hintPath).toBe("plugins.entries.pack/one.config");
    const providerChild = lookup?.children.find((child) => child.key === "provider");
    expect(providerChild?.key).toBe("provider");
    expect(providerChild?.path).toBe("plugins.entries.pack/one.config.provider");
    expect(providerChild?.type).toBe("string");
  });

  it("adds heartbeat target hints with dynamic channels", () => {
    const res = buildConfigSchema(heartbeatChannelInput);

    const defaultsHint = res.uiHints["agents.defaults.heartbeat.target"];
    const listHint = res.uiHints["agents.list.*.heartbeat.target"];
    expect(defaultsHint?.help).toContain("imessage");
    expect(defaultsHint?.help).toContain("last");
    expect(listHint?.help).toContain("imessage");
  });

  it("caches merged schemas for identical plugin/channel metadata", () => {
    const first = buildConfigSchema(cachedMergeInput);
    const plugin = expectDefined(cachedMergeInput.plugins?.[0], "cached plugin metadata");
    const channel = expectDefined(cachedMergeInput.channels?.[0], "cached channel metadata");
    const second = buildConfigSchema({
      plugins: [{ ...plugin }],
      channels: [{ ...channel }],
    });
    expect(second).toBe(first);
  });

  it("derives tags for security, network, storage, tools, and performance paths", () => {
    const tagged = applyDerivedTags({
      "gateway.auth.token": {},
      "proxy.tls.caFile": {},
      "tools.web.fetch.timeoutSeconds": {},
    });
    expect(tagged["gateway.auth.token"]?.tags).toEqual(
      expect.arrayContaining(["security", "auth"]),
    );
    expect(tagged["proxy.tls.caFile"]?.tags).toEqual(
      expect.arrayContaining(["security", "network", "storage"]),
    );
    expect(tagged["tools.web.fetch.timeoutSeconds"]?.tags).toEqual(
      expect.arrayContaining(["tools", "performance"]),
    );
  });

  it("covers core config paths with derived tags", () => {
    for (const [key, hint] of Object.entries(baseSchema.uiHints)) {
      if (key.includes(".")) {
        expect(hint.tags?.length ?? 0, `expected tags for ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("rejects removed Firecrawl config from the core web fetch schema", () => {
    const result = ToolsSchema.safeParse({
      web: {
        fetch: {
          readability: true,
          firecrawl: {
            enabled: true,
            apiKey: "firecrawl-test-key",
            baseUrl: "https://api.firecrawl.dev",
            onlyMainContent: true,
            maxAgeMs: 60_000,
            timeoutSeconds: 15,
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("keeps top-level subagent tools schema limited to tool policy", () => {
    expect(
      ToolsSchema.safeParse({
        subagents: { model: { primary: "openai/gpt-5.5" } },
      }).success,
    ).toBe(false);
  });

  it("keeps per-agent model overrides limited to model selection", () => {
    const result = OpenClawSchema.safeParse({
      agents: {
        entries: {
          main: {
            model: {
              primary: "openai/gpt-5.5",
              timeoutMs: 30_000,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects per-agent subagent model timeout config", () => {
    const result = OpenClawSchema.safeParse({
      agents: {
        entries: {
          main: {
            subagents: {
              model: {
                primary: "openai/gpt-5.5",
                timeoutMs: 30_000,
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts exec command highlighting config in global and agent scopes", () => {
    const tools = ToolsSchema.parse({
      exec: {
        commandHighlighting: false,
      },
    });
    expect(tools?.exec?.commandHighlighting).toBe(false);

    const config = OpenClawSchema.parse({
      agents: {
        entries: {
          main: {
            default: true,
            tools: {
              exec: {
                commandHighlighting: false,
              },
            },
          },
        },
      },
    });
    expect(config.agents?.entries?.main?.tools?.exec?.commandHighlighting).toBe(false);
  });

  it("accepts exec reviewer model config in global and agent scopes", () => {
    const tools = ToolsSchema.parse({
      exec: {
        reviewer: {
          model: {
            primary: "openrouter/anthropic/claude-sonnet-4-6",
          },
          timeoutMs: 15_000,
        },
      },
    });
    expect(tools?.exec?.reviewer?.model).toEqual({
      primary: "openrouter/anthropic/claude-sonnet-4-6",
    });

    const config = OpenClawSchema.parse({
      agents: {
        entries: {
          main: {
            default: true,
            tools: {
              exec: {
                reviewer: {
                  model: "openai/gpt-5.5",
                },
              },
            },
          },
        },
      },
    });
    expect(config.agents?.entries?.main?.tools?.exec?.reviewer?.model).toBe("openai/gpt-5.5");
  });

  it("rejects mixed normalized and legacy exec policy config", () => {
    expect(
      ToolsSchema.safeParse({
        exec: {
          mode: "auto",
          ask: "always",
        },
      }).success,
    ).toBe(false);

    expect(
      OpenClawSchema.safeParse({
        agents: {
          list: [
            {
              id: "main",
              tools: {
                exec: {
                  mode: "full",
                  security: "deny",
                },
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts experimental tool flags in the runtime zod schema", () => {
    const parsed = ToolsSchema.parse({
      experimental: {
        planTool: true,
      },
    });
    if (!parsed) {
      throw new Error("expected parsed tools config");
    }

    expect(parsed?.experimental?.planTool).toBe(true);
  });

  it("accepts simplified Tool Search config in the runtime zod schema", () => {
    expect(ToolsSchema.parse({ toolSearch: true })?.toolSearch).toBe(true);
    expect(
      ToolsSchema.parse({
        toolSearch: {
          enabled: true,
          mode: "directory",
          codeTimeoutMs: 5000,
          searchDefaultLimit: 4,
          maxSearchLimit: 12,
        },
      })?.toolSearch,
    ).toEqual({
      enabled: true,
      mode: "directory",
      codeTimeoutMs: 5000,
      searchDefaultLimit: 4,
      maxSearchLimit: 12,
    });
    expect(
      ToolsSchema.safeParse({
        toolSearch: {
          enabled: true,
          mode: "both",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts install policy exec config in the runtime zod schema", () => {
    const parsed = OpenClawSchema.parse({
      security: {
        installPolicy: {
          enabled: true,
          targets: ["skill", "plugin"],
          exec: {
            source: "exec",
            command: "/usr/local/bin/openclaw-install-policy",
            args: ["--json"],
            timeoutMs: 5000,
            noOutputTimeoutMs: 2500,
            maxOutputBytes: 65536,
            env: {
              POLICY_MODE: "strict",
            },
            passEnv: ["OPENCLAW_STATE_DIR"],
            trustedDirs: ["/usr/local/bin"],
          },
        },
      },
    });

    expect(parsed.security?.installPolicy?.targets).toEqual(["skill", "plugin"]);
    expect(parsed.security?.installPolicy?.exec?.source).toBe("exec");
    expect(parsed.security?.installPolicy?.exec?.command).toBe(
      "/usr/local/bin/openclaw-install-policy",
    );
  });

  it("accepts Code Mode config in the runtime zod schema", () => {
    expect(ToolsSchema.parse({ codeMode: true })?.codeMode).toBe(true);
    expect(
      ToolsSchema.parse({
        codeMode: {
          enabled: true,
          runtime: "quickjs-wasi",
          mode: "only",
          languages: ["javascript", "typescript"],
          timeoutMs: 5000,
          memoryLimitBytes: 67_108_864,
          maxOutputBytes: 65_536,
          maxSnapshotBytes: 10_485_760,
          maxPendingToolCalls: 8,
          snapshotTtlSeconds: 900,
          searchDefaultLimit: 4,
          maxSearchLimit: 12,
        },
      })?.codeMode,
    ).toEqual({
      enabled: true,
      runtime: "quickjs-wasi",
      mode: "only",
      languages: ["javascript", "typescript"],
      timeoutMs: 5000,
      memoryLimitBytes: 67_108_864,
      maxOutputBytes: 65_536,
      maxSnapshotBytes: 10_485_760,
      maxPendingToolCalls: 8,
      snapshotTtlSeconds: 900,
      searchDefaultLimit: 4,
      maxSearchLimit: 12,
    });
    expect(
      ToolsSchema.safeParse({
        codeMode: {
          enabled: true,
          runtime: "node",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts strict Swarm config in the runtime zod schema", () => {
    expect(ToolsSchema.parse({ swarm: true })?.swarm).toBe(true);
    expect(
      ToolsSchema.parse({
        swarm: {
          enabled: true,
          maxConcurrent: 8,
          maxChildrenPerGroup: 50,
          maxTotalPerGroup: 200,
          waitTimeoutSecondsMax: 600,
          defaultAgentId: "reviewer",
        },
      })?.swarm,
    ).toEqual({
      enabled: true,
      maxConcurrent: 8,
      maxChildrenPerGroup: 50,
      maxTotalPerGroup: 200,
      waitTimeoutSecondsMax: 600,
      defaultAgentId: "reviewer",
    });
    expect(ToolsSchema.safeParse({ swarm: { unknownKey: true } }).success).toBe(false);
  });

  it("accepts web fetch maxResponseBytes in the runtime zod schema", () => {
    const parsed = ToolsSchema.parse({
      web: {
        fetch: {
          maxResponseBytes: 2_000_000,
        },
      },
    });

    expect(parsed?.web?.fetch?.maxResponseBytes).toBe(2_000_000);
  });

  it("accepts web fetch ssrfPolicy in the runtime zod schema", () => {
    const parsed = ToolsSchema.parse({
      web: {
        fetch: {
          ssrfPolicy: {
            allowRfc2544BenchmarkRange: true,
            allowIpv6UniqueLocalRange: true,
          },
        },
      },
    });

    expect(parsed?.web?.fetch?.ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
    });
  });

  it("accepts web fetch trusted env proxy opt-in in the runtime zod schema", () => {
    const parsed = ToolsSchema.parse({
      web: {
        fetch: {
          useTrustedEnvProxy: true,
        },
      },
    });

    expect(parsed?.web?.fetch?.useTrustedEnvProxy).toBe(true);
  });

  it("rejects allowPrivateNetwork on media-understanding request config", () => {
    const result = ToolsSchema.safeParse({
      media: {
        models: [
          {
            provider: "openai",
            model: "gpt-4.1-mini",
            capabilities: ["image"],
            request: {
              allowPrivateNetwork: true,
            },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const requestIssue = result.error.issues.find(
        (issue) => JSON.stringify(issue.path) === JSON.stringify(["media", "models", 0, "request"]),
      );
      expect(requestIssue?.path).toEqual(["media", "models", 0, "request"]);
      const requestKeys = (requestIssue as { keys?: unknown } | undefined)?.keys;
      expect(requestKeys).toEqual(["allowPrivateNetwork"]);
    }
  });

  it("looks up a config schema path with immediate child summaries", () => {
    const lookup = lookupConfigSchema(baseSchema, "gateway.auth");
    expect(lookup?.path).toBe("gateway.auth");
    expect(lookup?.hintPath).toBe("gateway.auth");
    expect(lookup?.children.map((child) => child.key)).toContain("token");
    const tokenChild = lookup?.children.find((child) => child.key === "token");
    expect(tokenChild?.path).toBe("gateway.auth.token");
    expect(tokenChild?.hint?.sensitive).toBe(true);
    expect(tokenChild?.hint?.advanced).toBe(false);
    expect(tokenChild?.hintPath).toBe("gateway.auth.token");
    const schema = lookup?.schema as { properties?: unknown } | undefined;
    expect(schema?.properties).toBeUndefined();
  });

  it("materializes resolved common and advanced tiers in schema hints", () => {
    expect(baseSchema.uiHints["gateway.port"]?.advanced).toBe(false);
    expect(baseSchema.uiHints["gateway.reload.mode"]?.advanced).toBe(true);
    expect(baseSchema.uiHints["agents.defaults.workspace"]?.advanced).toBe(false);
    expect(baseSchema.uiHints["agents.defaults.compaction.timeoutSeconds"]?.advanced).toBe(true);
  });

  it("preserves explicit common hints on numeric leaves while defaulting tuning advanced", () => {
    const hints = applyResolvedConfigTierHints(
      {
        type: "object",
        properties: {
          custom: {
            type: "object",
            properties: {
              visibleCount: { type: "integer" },
              tuningMs: { type: "integer" },
            },
          },
        },
      },
      {
        custom: { advanced: false },
        "custom.visibleCount": { advanced: false },
      },
    );
    expect(hints["custom.visibleCount"]?.advanced).toBe(false);
    expect(hints["custom.tuningMs"]?.advanced).toBe(true);
  });

  it("looks up root config schema children without returning the full schema tree", () => {
    const lookup = lookupConfigSchema(baseSchema, ".");
    expect(lookup?.path).toBe(".");
    expect(lookup?.children.map((child) => child.key)).toContain("gateway");
    expect(lookup?.children.find((child) => child.key === "gateway")?.path).toBe("gateway");
    const schema = lookup?.schema as { properties?: unknown } | undefined;
    expect(schema?.properties).toBeUndefined();
  });

  it("lists Matrix in messages.queue.byChannel schema lookup", () => {
    const lookup = lookupConfigSchema(baseSchema, "messages.queue.byChannel");
    expect(lookup?.path).toBe("messages.queue.byChannel");
    expect(lookup?.children.map((child) => child.key)).toEqual(expect.arrayContaining(["matrix"]));
    expect(lookup?.schema).toMatchObject({ additionalProperties: false });
  });

  it("includes reload metadata when a resolver is provided", () => {
    const lookup = lookupConfigSchema(baseSchema, "gateway", (path) => {
      if (path === "gateway.auth.mode") {
        return { kind: "hot" };
      }
      if (path.startsWith("gateway")) {
        return { kind: "restart" };
      }
      return { kind: "none" };
    });

    expect(lookup?.reloadKind).toBe("restart");
    expect(lookup?.children.find((child) => child.path === "gateway.port")?.reloadKind).toBe(
      "restart",
    );
    expect(lookup?.children.find((child) => child.path === "gateway.auth")?.reloadKind).toBe(
      "restart",
    );
  });

  it("returns a shallow lookup schema without nested composition keywords", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.entries.main.runtime");
    expect(lookup?.path).toBe("agents.entries.main.runtime");
    expect(lookup?.hintPath).toBe("agents.entries.*.runtime");
    expect(lookup?.schema).not.toHaveProperty("allOf");
    expect(lookup?.schema).not.toHaveProperty("oneOf");
    const schema = lookup?.schema as { anyOf?: Array<{ properties?: Record<string, unknown> }> };
    expect(schema.anyOf?.some((variant) => variant.properties?.type)).toBe(true);
    expect(lookup?.schema).toHaveProperty("title", "Agent Runtime");
    expect(lookup?.schema).toHaveProperty("description");
  });

  it("keeps scoped record entry schemas for form editing", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.entries");
    expect(lookup?.schema).toHaveProperty("additionalProperties");
    const schema = lookup?.schema as
      | {
          additionalProperties?: {
            properties?: Record<
              string,
              { anyOf?: Array<{ properties?: Record<string, unknown> }> }
            >;
          };
        }
      | undefined;
    expect(schema?.additionalProperties?.properties).toHaveProperty("runtime");
    const runtimeVariants = schema?.additionalProperties?.properties?.runtime?.anyOf ?? [];
    expect(runtimeVariants.length).toBeGreaterThan(0);
    expect(runtimeVariants.some((variant) => variant.properties?.type)).toBe(true);
  });

  it("keeps scoped map properties for form editing", () => {
    const lookup = lookupConfigSchema(baseSchema, "env");
    expect(lookup?.children.map((child) => child.key)).toEqual(["shellEnv", "vars"]);
  });

  it("matches wildcard ui hints for concrete lookup paths", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.entries.main.identity.avatar");
    expect(lookup?.path).toBe("agents.entries.main.identity.avatar");
    expect(lookup?.hintPath).toBe("agents.entries.*.identity.avatar");
    expect(lookup?.hint?.help).toContain("workspace-relative path");
    expect(lookup?.schema?.title).toBe("Identity Avatar");
    expect(lookup?.schema?.description).toContain("Agent avatar");
  });

  it("rejects quoted bracket map paths", () => {
    const lookup = lookupConfigSchema(baseSchema, 'agents.entries["main"].identity.avatar');
    expect(lookup).toBeNull();
  });

  it("matches ui hints for keyed record entries", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.entries.main.runtime");
    expect(lookup?.path).toBe("agents.entries.main.runtime");
    expect(lookup?.hintPath).toBe("agents.entries.*.runtime");
    expect(lookup?.hint?.label).toBe("Agent Runtime");
  });

  it("uses the indexed tuple item schema for positional array lookups", () => {
    const tupleSchema = {
      schema: {
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      },
      uiHints: {},
      version: "test",
      generatedAt: "test",
    } as unknown as Parameters<typeof lookupConfigSchema>[0];

    const lookup = lookupConfigSchema(tupleSchema, "pair.1");
    expect(lookup?.path).toBe("pair.1");
    expect(lookup?.schema?.type).toBe("number");
    expect((lookup?.schema as { items?: unknown } | undefined)?.items).toBeUndefined();
  });

  it("rejects impractical numeric tuple lookup indexes", () => {
    const tupleSchema = {
      schema: {
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      },
      uiHints: {},
      version: "test",
      generatedAt: "test",
    } as unknown as Parameters<typeof lookupConfigSchema>[0];

    expect(lookupConfigSchema(tupleSchema, "pair.4294967294")).toBeNull();
  });

  it("rejects prototype-chain lookup segments", () => {
    expect(lookupConfigSchema(baseSchema, "constructor")).toBeNull();
    expect(lookupConfigSchema(baseSchema, "__proto__.polluted")).toBeNull();
  });

  it("rejects overly deep lookup paths", () => {
    const buildNestedObjectSchema = (
      segments: string[],
    ): { type: string; properties?: Record<string, unknown> } => {
      const [head, ...rest] = segments;
      if (!head) {
        return { type: "string" };
      }
      return {
        type: "object",
        properties: {
          [head]: buildNestedObjectSchema(rest),
        },
      };
    };

    const deepPathSegments = Array.from({ length: 33 }, (_, index) => `a${index}`);
    const deepSchema = {
      schema: buildNestedObjectSchema(deepPathSegments),
      uiHints: {},
      version: "test",
      generatedAt: "test",
    } as unknown as Parameters<typeof lookupConfigSchema>[0];

    expect(lookupConfigSchema(deepSchema, deepPathSegments.join("."))).toBeNull();
  });

  it("returns null for missing config schema paths", () => {
    expect(lookupConfigSchema(baseSchema, "gateway.notReal.path")).toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
