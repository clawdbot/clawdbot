import { beforeAll, describe, expect, it } from "vitest";
import { SENSITIVE_URL_HINT_TAG } from "../shared/net/redact-sensitive-url.js";
import { buildConfigSchema, lookupConfigSchema } from "./schema.js";
import { applyDerivedTags, CONFIG_TAGS, deriveTagsForPath } from "./schema.tags.js";
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
    const groupPolicyLabel = res.uiHints["channels.defaults.groupPolicy"]?.label;
    expect(groupPolicyLabel).toBeTypeOf("string");
    expect(groupPolicyLabel?.trim().length).toBeGreaterThan(0);
    expect(res.uiHints["mcp.servers.*.headers.*"]?.sensitive).toBe(true);
    expect(res.uiHints["mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
    expect(res.uiHints["models.providers.*.baseUrl"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
    expect(res.version).toBeTypeOf("string");
    expect(res.version.trim().length).toBeGreaterThan(0);
    expect(res.generatedAt).toBeTypeOf("string");
    expect(res.generatedAt.trim().length).toBeGreaterThan(0);
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
    expect(res.uiHints["channels.matrix"]?.label).toBe("Matrix");
    expect(res.uiHints["channels.matrix.accessToken"]?.sensitive).toBe(true);
    expect(res.uiHints["channels.matrix.streaming.progress.label"]?.label).toBe(
      "Matrix Progress Label",
    );
    expect(res.uiHints["channels.discord.streaming.progress.toolProgress"]?.label).toBe(
      "Discord Progress Tool Lines",
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
    const second = buildConfigSchema({
      plugins: [{ ...cachedMergeInput.plugins![0] }],
      channels: [{ ...cachedMergeInput.channels![0] }],
    });
    expect(second).toBe(first);
  });

  it("derives security/auth tags for credential paths", () => {
    const tags = deriveTagsForPath("gateway.auth.token");
    expect(tags).toContain("security");
    expect(tags).toContain("auth");
  });

  it("derives tools/performance tags for web fetch timeout paths", () => {
    const tags = deriveTagsForPath("tools.web.fetch.timeoutSeconds");
    expect(tags).toContain("tools");
    expect(tags).toContain("performance");
  });

  it("accepts web fetch readability and firecrawl config in the runtime zod schema", () => {
    const parsed = ToolsSchema.parse({
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

    expect(parsed?.web?.fetch?.readability).toBe(true);
    expect(parsed?.web?.fetch?.firecrawl).toEqual({
      enabled: true,
      apiKey: "firecrawl-test-key",
      baseUrl: "https://api.firecrawl.dev",
      onlyMainContent: true,
      maxAgeMs: 60_000,
      timeoutSeconds: 15,
    });
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
        list: [
          {
            id: "main",
            tools: {
              exec: {
                commandHighlighting: false,
              },
            },
          },
        ],
      },
    });
    expect(config.agents?.list?.[0]?.tools?.exec?.commandHighlighting).toBe(false);
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
          mode: "tools",
          codeTimeoutMs: 5000,
          searchDefaultLimit: 4,
          maxSearchLimit: 12,
        },
      })?.toolSearch,
    ).toEqual({
      enabled: true,
      mode: "tools",
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

  it("accepts WhatsApp Web Baileys socket timing in the runtime zod schema", () => {
    const parsed = OpenClawSchema.parse({
      web: {
        whatsapp: {
          keepAliveIntervalMs: 15_000,
          connectTimeoutMs: 60_000,
          defaultQueryTimeoutMs: 90_000,
        },
      },
    });

    expect(parsed.web?.whatsapp).toEqual({
      keepAliveIntervalMs: 15_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 90_000,
    });
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
        image: {
          models: [
            {
              provider: "openai",
              model: "gpt-4.1-mini",
              request: {
                allowPrivateNetwork: true,
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const requestIssue = result.error.issues.find(
        (issue) =>
          JSON.stringify(issue.path) === JSON.stringify(["media", "image", "models", 0, "request"]),
      );
      expect(requestIssue?.path).toEqual(["media", "image", "models", 0, "request"]);
      const requestKeys = (requestIssue as { keys?: unknown } | undefined)?.keys;
      expect(requestKeys).toEqual(["allowPrivateNetwork"]);
    }
  });

  it("rejects unknown keys inside web fetch firecrawl config", () => {
    const result = ToolsSchema.safeParse({
      web: {
        fetch: {
          firecrawl: {
            enabled: true,
            nope: true,
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const firecrawlIssue = result.error.issues.find(
        (issue) => JSON.stringify(issue.path) === JSON.stringify(["web", "fetch", "firecrawl"]),
      );
      expect(firecrawlIssue?.path).toEqual(["web", "fetch", "firecrawl"]);
      const firecrawlKeys = (firecrawlIssue as { keys?: unknown } | undefined)?.keys;
      expect(firecrawlKeys).toEqual(["nope"]);
    }
  });

  it("keeps tags in the allowed taxonomy", () => {
    const withTags = applyDerivedTags({
      "gateway.auth.token": {},
      "tools.web.fetch.timeoutSeconds": {},
      "channels.slack.accounts.*.token": {},
    });
    const allowed = new Set<string>(CONFIG_TAGS);
    for (const hint of Object.values(withTags)) {
      for (const tag of hint.tags ?? []) {
        expect(allowed.has(tag)).toBe(true);
      }
    }
  });

  it("covers core/built-in config paths with tags", () => {
    const schema = baseSchema;
    const allowed = new Set<string>([...CONFIG_TAGS, SENSITIVE_URL_HINT_TAG]);
    for (const [key, hint] of Object.entries(schema.uiHints)) {
      if (!key.includes(".")) {
        continue;
      }
      const tags = hint.tags ?? [];
      expect(tags.length, `expected tags for ${key}`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(allowed.has(tag), `unexpected tag ${tag} on ${key}`).toBe(true);
      }
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
    expect(tokenChild?.hintPath).toBe("gateway.auth.token");
    const schema = lookup?.schema as { properties?: unknown } | undefined;
    expect(schema?.properties).toBeUndefined();
  });

  it("returns a shallow lookup schema without nested composition keywords", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list.0.runtime");
    expect(lookup?.path).toBe("agents.list.0.runtime");
    expect(lookup?.hintPath).toBe("agents.list[].runtime");
    // The shallow lookup schema carries field docs, but should not expose
    // nested composition keywords (allOf, oneOf, etc.).
    expect(lookup?.schema).not.toHaveProperty("allOf");
    expect(lookup?.schema).not.toHaveProperty("oneOf");
    expect(lookup?.schema).not.toHaveProperty("anyOf");
    expect(lookup?.schema).toHaveProperty("title", "Agent Runtime");
    expect(lookup?.schema).toHaveProperty("description");
  });

  it("matches wildcard ui hints for concrete lookup paths", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list.0.identity.avatar");
    expect(lookup?.path).toBe("agents.list.0.identity.avatar");
    expect(lookup?.hintPath).toBe("agents.list.*.identity.avatar");
    expect(lookup?.hint?.help).toContain("workspace-relative path");
    expect(lookup?.schema?.title).toBe("Identity Avatar");
    expect(lookup?.schema?.description).toContain("Agent avatar");
  });

  it("normalizes bracketed lookup paths", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list[0].identity.avatar");
    expect(lookup?.path).toBe("agents.list.0.identity.avatar");
    expect(lookup?.hintPath).toBe("agents.list.*.identity.avatar");
  });

  it("matches ui hints that use empty array brackets", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list.0.runtime");
    expect(lookup?.path).toBe("agents.list.0.runtime");
    expect(lookup?.hintPath).toBe("agents.list[].runtime");
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
