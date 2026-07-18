// Migrate Hermes tests cover config plugin behavior.
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHermesMigrationProvider } from "./provider.js";
import {
  cleanupTempRoots,
  makeConfigRuntime,
  makeContext,
  makeTempRoot,
  writeFile,
} from "./test/provider-helpers.js";

function itemById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

function modelProviderValues(
  items: Array<{ id: string; details?: { value?: unknown } }>,
): Record<string, unknown> {
  return Object.assign(
    {},
    ...items
      .filter((item) => item.id.startsWith("config:model-provider:"))
      .map((item) => item.details?.value),
  );
}

describe("Hermes migration config mapping", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupTempRoots();
  });

  it("plans provider, MCP, skill, and memory plugin config as plugin-owned items", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: custom:acme",
        "  default: vendor/custom-v1",
        "providers:",
        "  acme:",
        "    api: https://api.acme.example/v1",
        "    key_env: ACME_TOKEN",
        "    default_model: vendor/custom-v1",
        "    transport: codex_responses",
        "    models:",
        "      vendor/custom-v1:",
        "        context_length: 262144",
        "        max_tokens: 16384",
        "custom_providers:",
        "  - name: local-llm",
        "    base_url: http://127.0.0.1:11434/v1",
        "    models: [local-model]",
        "memory:",
        "  provider: honcho",
        "  honcho:",
        "    project: hermes",
        "skills:",
        "  config:",
        "    ship-it:",
        "      mode: fast",
        "mcp_servers:",
        "  time:",
        "    enabled: false",
        "    command: npx",
        "    args: ['-y', 'mcp-server-time']",
        "    timeout: 45",
        "    connect_timeout: 10",
        "    supports_parallel_tool_calls: true",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(source, "memories", "MEMORY.md"), "memory line\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir }));

    const memoryPlugin = itemById(plan.items, "config:memory-plugin:honcho");
    expect(memoryPlugin?.kind).toBe("config");
    expect(memoryPlugin?.action).toBe("merge");
    expect(memoryPlugin?.target).toBe("plugins.entries.honcho");

    const manualMemory = itemById(plan.items, "manual:memory-provider:honcho");
    expect(manualMemory?.kind).toBe("manual");
    expect(manualMemory?.status).toBe("skipped");

    const modelProviderValue = modelProviderValues(plan.items) as
      | {
          acme?: { baseUrl?: string; apiKey?: unknown; api?: string; models?: unknown[] };
          "local-llm"?: { baseUrl?: string };
        }
      | undefined;
    expect(modelProviderValue?.acme?.baseUrl).toBe("https://api.acme.example/v1");
    expect(modelProviderValue?.acme?.apiKey).toBeUndefined();
    expect(modelProviderValue?.acme?.api).toBe("openai-responses");
    expect(modelProviderValue?.acme?.models).toEqual([
      expect.objectContaining({
        id: "vendor/custom-v1",
        contextWindow: 262_144,
        maxTokens: 16_384,
        api: "openai-responses",
      }),
    ]);
    expect(modelProviderValue?.["local-llm"]?.baseUrl).toBe("http://127.0.0.1:11434/v1");

    const mcpServers = itemById(plan.items, "config:mcp-server:time");
    expect(mcpServers?.details?.value).toEqual({
      time: {
        enabled: false,
        command: "npx",
        args: ["-y", "mcp-server-time"],
        timeout: 45,
        connectTimeout: 10,
        supportsParallelToolCalls: true,
      },
    });

    const skillEntries = itemById(plan.items, "config:skill-entries");
    expect(skillEntries?.details?.value).toEqual({
      "ship-it": {
        config: {
          mode: "fast",
        },
      },
    });
    expect(plan.warnings).toEqual([
      "Some Hermes settings require manual review before they can be activated safely.",
    ]);
  });

  it("applies mapped config items through the migration runtime config writer", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
    } as OpenClawConfig;
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "providers:",
        "  openai:",
        "    api: https://api.openai.example/v1",
        "    key_env: OPENAI_API_KEY",
        "    default_model: gpt-5.4",
        "    transport: chat_completions",
        "    models: [gpt-5.4]",
        "mcp_servers:",
        "  time:",
        "    command: npx",
        "skills:",
        "  config:",
        "    ship-it:",
        "      mode: fast",
        "",
      ].join("\n"),
    );

    const provider = buildHermesMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        runtime: makeConfigRuntime(config),
      }),
    );

    expect(result.summary.errors).toBe(0);
    expect(config.models?.providers?.openai?.apiKey).toBeUndefined();
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "manual:model-provider-key-env:openai",
          kind: "manual",
        }),
      ]),
    );
    expect(config.mcp?.servers?.time?.command).toBe("npx");
    expect(config.skills?.entries?.["ship-it"]?.config?.mode).toBe("fast");
  });

  it("drops prototype-bearing provider, MCP, and skill keys during apply", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
    } as OpenClawConfig;
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "providers:",
        '  "__proto__":',
        "    base_url: https://untrusted.example/v1",
        "    models: [untrusted-model]",
        "mcp_servers:",
        "  constructor:",
        "    command: untrusted-command",
        "  safe-server:",
        "    command: safe-command",
        "skills:",
        "  config:",
        "    prototype:",
        "      mode: untrusted",
        "    safe-skill:",
        "      mode: safe",
        "",
      ].join("\n"),
    );

    const result = await buildHermesMigrationProvider().apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        runtime: makeConfigRuntime(config),
      }),
    );

    expect(result.summary.errors).toBe(0);
    const providers = config.models?.providers as Record<string, unknown>;
    const servers = config.mcp?.servers as Record<string, unknown>;
    const skills = config.skills?.entries as Record<string, unknown>;
    expect(Object.hasOwn(providers, "__proto__")).toBe(false);
    expect(Object.hasOwn(servers, "constructor")).toBe(false);
    expect(Object.hasOwn(skills, "prototype")).toBe(false);
    expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
    expect((servers["safe-server"] as { command?: string }).command).toBe("safe-command");
    expect((skills["safe-skill"] as { config?: { mode?: string } }).config?.mode).toBe("safe");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("uses the provider runtime for CLI-applied config items", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const config: Record<string, unknown> = {
      agents: { defaults: { workspace: workspaceDir } },
    };
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "mcp_servers:",
        "  time:",
        "    command: npx",
        "    env:",
        "      OPENAI_API_KEY: short-dev-key",
        "",
      ].join("\n"),
    );

    const provider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(config) });
    const result = await provider.apply(
      makeContext({ source, stateDir, workspaceDir, includeSecrets: true }),
    );

    expect(result.summary.errors).toBe(0);
    const mcp = config.mcp as
      | { servers?: { time?: { command?: unknown; env?: { OPENAI_API_KEY?: unknown } } } }
      | undefined;
    expect(mcp?.servers?.time?.command).toBe("npx");
    expect(mcp?.servers?.time?.env?.OPENAI_API_KEY).toBe("short-dev-key");
  });

  it("omits MCP credentials without explicit secret consent", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const config: Record<string, unknown> = {};
    const envKey = ["TO", "KEN"].join("");
    await writeFile(
      path.join(source, "config.yaml"),
      `mcp_servers:\n  time:\n    command: npx\n    env:\n      ${envKey}: placeholder\n`,
    );
    const provider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(config) });
    const result = await provider.apply(makeContext({ source, stateDir, workspaceDir }));
    const mcp = config.mcp as { servers?: { time?: { env?: Record<string, string> } } } | undefined;
    expect(mcp?.servers?.time?.env).toBeUndefined();
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "manual:mcp-server-secrets:time", kind: "manual" }),
      ]),
    );
  });

  it("translates current Hermes model-scoped providers and MCP semantics", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const tlsFieldName = ["client", "cert"].join("_");
    const tlsPaths = ["placeholder", "placeholder"];
    const oauthConfig = {
      scope: "read",
      [["client", "id"].join("_")]: "placeholder",
      [["client", "secret"].join("_")]: "placeholder",
    };
    await writeFile(
      path.join(source, "config.yaml"),
      JSON.stringify({
        model: {
          provider: "custom",
          default: "vendor/current-model",
          base_url: "https://models.example/v1",
          api_mode: "anthropic_messages",
          api_key: "${SCOPED_MODEL_KEY}",
          context_length: 65_536,
          supports_vision: true,
        },
        mcp_servers: {
          remote: {
            url: "https://mcp.example/rpc",
            [tlsFieldName]: tlsPaths,
            ssl_verify: "/tls/ca.pem",
            auth: "oauth",
            oauth: oauthConfig,
            tools: {
              include: ["search"],
              exclude: ["danger"],
              resources: "off",
              prompts: true,
            },
            skip_preflight: true,
            sampling: { enabled: true },
            lifecycle: { idle_timeout_seconds: "60", max_lifetime_seconds: 3600 },
            keepalive_interval: 10,
          },
          protected: {
            url: "https://protected.example/rpc",
            [tlsFieldName]: [...tlsPaths, "placeholder"],
          },
          utilities_only: {
            command: "utilities-only",
            tools: { include: [], resources: false, prompts: true },
          },
          no_tools: {
            command: "no-tools",
            tools: { include: [], resources: false, prompts: false },
          },
        },
      }),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({ source, stateDir, workspaceDir }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { baseUrl?: string; api?: string; apiKey?: unknown; models?: unknown[] }>
      | undefined;
    expect(providers?.custom).toEqual(
      expect.objectContaining({
        baseUrl: "https://models.example",
        api: "anthropic-messages",
        models: [
          expect.objectContaining({
            id: "vendor/current-model",
            contextWindow: 65_536,
            input: ["text", "image"],
          }),
        ],
      }),
    );
    expect(providers?.custom?.apiKey).toBeUndefined();
    expect(itemById(plan.items, "manual:model-provider-key-env:custom")?.kind).toBe("manual");

    const remoteValue = itemById(plan.items, "config:mcp-server:remote")?.details?.value as
      | { remote?: Record<string, unknown> }
      | undefined;
    expect(remoteValue?.remote).toEqual(
      expect.objectContaining({
        url: "https://mcp.example/rpc",
        transport: "streamable-http",
        auth: "oauth",
        oauth: { scope: "read" },
        toolFilter: { include: ["search", "prompts_list", "prompts_get"] },
      }),
    );
    expect(remoteValue?.remote?.[["client", "Cert"].join("")]).toBe(tlsPaths[0]);
    expect(remoteValue?.remote?.[["client", "Key"].join("")]).toBe(tlsPaths[1]);
    expect(itemById(plan.items, "config:mcp-server:protected")?.details?.value).toEqual({
      protected: {
        url: "https://protected.example/rpc",
        transport: "streamable-http",
      },
    });
    expect(itemById(plan.items, "config:mcp-server:utilities_only")?.details?.value).toEqual({
      utilities_only: {
        command: "utilities-only",
        toolFilter: { exclude: ["resources_list", "resources_read"] },
      },
    });
    expect(itemById(plan.items, "config:mcp-server:no_tools")?.details?.value).toEqual({
      no_tools: {
        command: "no-tools",
        toolFilter: {
          exclude: ["resources_list", "resources_read", "prompts_list", "prompts_get"],
        },
      },
    });
    for (const id of [
      "manual:mcp-server-tls-ca:remote",
      "manual:mcp-server-preflight:remote",
      "manual:mcp-server-sampling:remote",
      "manual:mcp-server-lifecycle:remote",
      "manual:mcp-server-keepalive:remote",
      "manual:mcp-server-oauth-login:remote",
      "manual:mcp-server-oauth-client:remote",
      ["manual:mcp-server-client-cert-password", "protected"].join(":"),
    ]) {
      expect(itemById(plan.items, id)?.kind).toBe("manual");
    }
  });

  it("resolves provider endpoint refs and preserves supported request options", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const endpointEnv = ["ACME", "BASE", "URL"].join("_");
    const headerEnv = ["ACME", "HEADER"].join("_");
    await writeFile(
      path.join(source, "config.yaml"),
      JSON.stringify({
        providers: {
          acme: {
            api: `\${${endpointEnv}}`,
            transport: "openai_chat",
            models: {
              "acme-one": { max_output_tokens: 12_345 },
            },
            extra_headers: {
              "X-Environment": `\${${headerEnv}}`,
              "X-Invalid": { nested: true },
              "X-Literal": "literal-value",
            },
            extra_body: { service_tier: "flex" },
          },
        },
      }),
    );
    await writeFile(
      path.join(source, ".env"),
      `${endpointEnv}=https://acme.example.test/v1\n${headerEnv}=resolved-header-value\n`,
    );

    const withoutSecrets = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state-without-secrets"),
        workspaceDir: path.join(root, "workspace-without-secrets"),
      }),
    );
    const withoutSecretsProviders = modelProviderValues(withoutSecrets.items) as Record<
      string,
      {
        baseUrl?: string;
        headers?: Record<string, unknown>;
        models?: Array<{ maxTokens?: number }>;
      }
    >;
    expect(withoutSecretsProviders.acme).toEqual(
      expect.objectContaining({
        baseUrl: "https://acme.example.test/v1",
        models: [expect.objectContaining({ maxTokens: 12_345 })],
      }),
    );
    expect(itemById(withoutSecrets.items, "config:model-provider:acme")?.sensitive).toBe(true);
    expect(itemById(withoutSecrets.items, "manual:model-provider-headers:acme")?.kind).toBe(
      "manual",
    );
    expect(itemById(withoutSecrets.items, "manual:model-provider-extra-body:acme")?.kind).toBe(
      "manual",
    );

    const withSecrets = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state-with-secrets"),
        workspaceDir: path.join(root, "workspace-with-secrets"),
        includeSecrets: true,
      }),
    );
    const withSecretsProviders = modelProviderValues(withSecrets.items) as Record<
      string,
      { headers?: Record<string, unknown> }
    >;
    expect(withSecretsProviders.acme?.headers).toEqual({
      "X-Environment": "resolved-header-value",
      "X-Literal": "literal-value",
    });
    expect(itemById(withSecrets.items, "manual:model-provider-headers:acme")).toBeUndefined();
    expect(itemById(withSecrets.items, "manual:model-provider-headers-invalid:acme")?.kind).toBe(
      "manual",
    );
  });

  it("reports unresolved provider endpoint environment references", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      "providers:\n  acme:\n    api: ${MISSING_ACME_URL}\n    models: [acme-one]\n",
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(itemById(plan.items, "config:model-provider:acme")).toBeUndefined();
    expect(itemById(plan.items, "manual:model-provider-endpoint-env:acme")?.kind).toBe("manual");
  });

  it("infers Hermes provider protocols from provider and endpoint contracts", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "providers:",
        "  anthropic:",
        "    base_url: https://anthropic-proxy.example.test/v1",
        "    models: [claude-proxy-model]",
        "  claude-proxy:",
        "    base_url: https://proxy.example.test/anthropic",
        "    models: [claude-test]",
        "  claude-v1-proxy:",
        "    base_url: https://proxy.example.test/anthropic/v1",
        "    models: [claude-v1-test]",
        "  openai-direct:",
        "    base_url: https://api.openai.com/v1",
        "    models: [gpt-5.4]",
        "  openai-codex:",
        "    base_url: https://chatgpt.com/backend-api/codex",
        "    transport: codex_responses",
        "    models: [gpt-5.6]",
        "  xai-direct:",
        "    base_url: https://api.x.ai/v1",
        "    transport: codex_responses",
        "    models: [grok-4.1-fast]",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { api?: string; baseUrl?: string }>
      | undefined;
    expect(providers?.anthropic?.api).toBe("anthropic-messages");
    expect(providers?.["claude-proxy"]?.api).toBe("anthropic-messages");
    expect(providers?.["claude-v1-proxy"]?.api).toBe("anthropic-messages");
    expect(providers?.["claude-v1-proxy"]?.baseUrl).toBe("https://proxy.example.test/anthropic");
    expect(providers?.["openai-direct"]?.api).toBe("openai-responses");
    expect(providers?.openai?.api).toBe("openai-chatgpt-responses");
    expect(providers?.["xai-direct"]?.api).toBe("openai-responses");
  });

  it("matches Hermes transport precedence for named and plain custom providers", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: custom",
        "  default: kimi-custom",
        "  base_url: https://api.kimi.com/coding/v1",
        "  api_mode: codex_responses",
        "providers:",
        "  named-responses:",
        "    base_url: https://api.kimi.com/coding/v1",
        "    transport: codex_responses",
        "    models: [named-model]",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { api?: string }>
      | undefined;
    expect(providers?.["named-responses"]?.api).toBe("openai-responses");
    expect(providers?.custom?.api).toBe("anthropic-messages");
  });

  it("keeps built-in Hermes provider overrides on OpenClaw's canonical provider IDs", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: gemini",
        "  default: gemini-3.1-pro",
        "providers:",
        "  copilot:",
        "    base_url: https://copilot.example.test/v1",
        "    transport: openai_chat",
        "  gemini:",
        "    base_url: https://gemini.example.test/v1",
        "    transport: openai_chat",
        "  kimi-coding:",
        "    base_url: https://kimi.example.test/v1",
        "    transport: openai_chat",
        "  kimi-coding-cn:",
        "    base_url: https://moonshot.example.test/v1",
        "    transport: openai_chat",
        "  opencode-zen:",
        "    base_url: https://opencode.example.test/v1",
        "    transport: openai_chat",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as Record<string, { api?: string }>;
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe(
      "google/gemini-3.1-pro",
    );
    expect(Object.keys(providers).toSorted()).toEqual([
      "github-copilot",
      "google",
      "kimi",
      "moonshot",
      "opencode",
    ]);
    expect(
      Object.values(providers).every((provider) => provider.api === "openai-completions"),
    ).toBe(true);
  });

  it("isolates model provider conflicts", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: existing",
        "  default: imported-model",
        "providers:",
        "  existing:",
        "    base_url: https://new-existing.example.test/v1",
        "    transport: openai_chat",
        "  fresh:",
        "    base_url: https://fresh.example.test/v1",
        "    transport: openai_chat",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir,
        config: {
          agents: { defaults: { workspace: workspaceDir } },
          models: {
            providers: {
              existing: {
                baseUrl: "https://old-existing.example.test/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
      }),
    );

    expect(itemById(plan.items, "config:model-provider:existing")?.status).toBe("conflict");
    expect(itemById(plan.items, "config:model-provider:fresh")?.status).toBe("planned");
    expect(itemById(plan.items, "config:default-model")?.status).toBe("conflict");
  });

  it.each([
    {
      sourceProvider: "openai-api",
      envName: "OPENAI_BASE_URL",
      envValue: "https://openai-proxy.example.test/v1",
      targetProvider: "openai",
      expectedApi: "openai-responses",
      expectedBaseUrl: "https://openai-proxy.example.test/v1",
    },
    {
      sourceProvider: "kimi-for-coding",
      envName: "KIMI_BASE_URL",
      envValue: "https://api.kimi.com/coding/v1",
      targetProvider: "kimi",
      expectedApi: "anthropic-messages",
      expectedBaseUrl: "https://api.kimi.com/coding",
    },
    {
      sourceProvider: "minimax",
      envName: "MINIMAX_BASE_URL",
      envValue: "https://minimax-proxy.example.test/anthropic/v1",
      targetProvider: "minimax",
      expectedApi: "anthropic-messages",
      expectedBaseUrl: "https://minimax-proxy.example.test/anthropic",
    },
    {
      sourceProvider: "alibaba",
      envName: "DASHSCOPE_BASE_URL",
      envValue: "https://dashscope-proxy.example.test/compatible-mode/v1",
      targetProvider: "qwen",
      expectedApi: "openai-completions",
      expectedBaseUrl: "https://dashscope-proxy.example.test/compatible-mode/v1",
    },
    {
      sourceProvider: "qwen-oauth",
      envName: "HERMES_QWEN_BASE_URL",
      envValue: "https://qwen-proxy.example.test/v1",
      targetProvider: "qwen",
      expectedApi: "openai-completions",
      expectedBaseUrl: "https://qwen-proxy.example.test/v1",
    },
  ])(
    "imports $envName as the selected $sourceProvider endpoint",
    async ({ sourceProvider, envName, envValue, targetProvider, expectedApi, expectedBaseUrl }) => {
      const root = await makeTempRoot();
      const source = path.join(root, "hermes");
      await writeFile(
        path.join(source, "config.yaml"),
        ["model:", `  provider: ${sourceProvider}`, "  default: imported-model", ""].join("\n"),
      );
      await writeFile(path.join(source, ".env"), `${envName}=${envValue}\n`);

      const plan = await buildHermesMigrationProvider().plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir: path.join(root, "workspace"),
        }),
      );
      const providers = modelProviderValues(plan.items) as
        | Record<string, { api?: string; baseUrl?: string; models?: Array<{ id?: string }> }>
        | undefined;

      expect(providers?.[targetProvider]).toMatchObject({
        api: expectedApi,
        baseUrl: expectedBaseUrl,
      });
      expect(providers?.[targetProvider]?.models).toEqual([
        expect.objectContaining({ id: "imported-model" }),
      ]);
    },
  );

  it("preserves the standard Alibaba endpoint instead of the coding-plan default", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: alibaba\n  default: qwen-plus\n",
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { baseUrl?: string }>
      | undefined;
    expect(providers?.qwen?.baseUrl).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("qwen/qwen-plus");
  });

  it("resolves MCP environment references with source dotenv precedence and secret consent", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const mcpEnvName = ["MCP", "VALUE"].join("_");
    const mcpUrlName = ["MCP", "URL"].join("_");
    const dottedEnvName = ["mcp", "value"].join(".");
    const dashedEnvName = ["MCP", "VALUE"].join("-");
    const inheritedEnvName = ["MCP", "INHERITED"].join("_");
    vi.stubEnv(inheritedEnvName, "inherited-placeholder");
    await writeFile(
      path.join(source, ".env"),
      `${mcpEnvName}=placeholder\n${mcpUrlName}=https://mcp.example.test/rpc\n${dottedEnvName}=dotted-placeholder\n${dashedEnvName}=dashed-placeholder\n`,
    );
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "mcp_servers:",
        "  resolved:",
        `    url: '\${${mcpUrlName}}'`,
        `    args: ['--value', '\${${mcpEnvName}}']`,
        "    headers:",
        `      Authorization: 'Bearer \${${mcpEnvName}}'`,
        `      X-Dotted: '\${${dottedEnvName}}'`,
        `    env:`,
        `      DASHED: '\${env:${dashedEnvName}}'`,
        `      INHERITED: '\${${inheritedEnvName}}'`,
        "  unresolved:",
        "    command: unresolved",
        "    env:",
        "      VALUE: '${env:MISSING_VALUE}'",
        "  missing-launch:",
        "    command: '${env:MISSING_COMMAND}'",
        "    enabled: true",
        "    args: ['--serve']",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
        includeSecrets: true,
      }),
    );
    expect(itemById(plan.items, "config:mcp-server:resolved")?.details?.value).toEqual({
      resolved: {
        url: "https://mcp.example.test/rpc",
        args: ["--value", "placeholder"],
        transport: "streamable-http",
        headers: { Authorization: "Bearer placeholder", "X-Dotted": "dotted-placeholder" },
        env: { DASHED: "dashed-placeholder", INHERITED: "inherited-placeholder" },
      },
    });
    expect(itemById(plan.items, "config:mcp-server:resolved")?.sensitive).toBe(true);
    expect(itemById(plan.items, "config:mcp-server:unresolved")?.details?.value).toEqual({
      unresolved: { command: "unresolved" },
    });
    expect(itemById(plan.items, "manual:mcp-server-unresolved-secrets:unresolved")?.kind).toBe(
      "manual",
    );
    expect(itemById(plan.items, "config:mcp-server:missing-launch")).toBeUndefined();
    expect(itemById(plan.items, "manual:mcp-server-unresolved-secrets:missing-launch")?.kind).toBe(
      "manual",
    );

    const withoutSecrets = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state-without-secrets"),
        workspaceDir: path.join(root, "workspace-without-secrets"),
      }),
    );
    expect(itemById(withoutSecrets.items, "config:mcp-server:resolved")).toBeUndefined();
    expect(itemById(withoutSecrets.items, "manual:mcp-server-secrets:resolved")?.kind).toBe(
      "manual",
    );
    expect(itemById(withoutSecrets.items, "config:mcp-server:missing-launch")).toBeUndefined();
    expect(itemById(withoutSecrets.items, "manual:mcp-server-secrets:missing-launch")?.kind).toBe(
      "manual",
    );
  });

  it("imports a model-scoped endpoint even when Hermes names a built-in provider", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: kimi-for-coding",
        "  default: kimi-k2.5",
        "  base_url: https://proxy.example.test/v1",
        "  api_mode: chat_completions",
        "custom_providers:",
        "  - name: My Local LLM",
        "    base_url: https://local.example.test/v1",
        "    models: [local-model]",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { baseUrl?: string; models?: Array<{ id?: string }> }>
      | undefined;
    expect(providers?.kimi).toEqual(
      expect.objectContaining({
        baseUrl: "https://proxy.example.test/v1",
        models: [expect.objectContaining({ id: "kimi-k2.5" })],
      }),
    );
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("kimi/kimi-k2.5");
    expect(providers?.["my-local-llm"]?.baseUrl).toBe("https://local.example.test/v1");
  });

  it("preserves an explicit Hermes provider name before applying built-in aliases", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: kimi",
        "  default: private-model",
        "providers:",
        "  kimi:",
        "    api: https://private-kimi.example.test/v1",
        "    default_model: private-model",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { baseUrl?: string }>
      | undefined;
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("kimi/private-model");
    expect(providers?.kimi?.baseUrl).toBe("https://private-kimi.example.test/v1");
    expect(providers?.["kimi-coding"]).toBeUndefined();
  });

  it("keeps current providers entries ahead of matching legacy custom providers", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const envVar = ["CURRENT", "ACME", "TOKEN"].join("_");
    const legacyEnvVar = ["LEGACY", "ACME", "TOKEN"].join("_");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: acme",
        "  default: current-model",
        "providers:",
        "  acme:",
        "    api: https://current.example.test/v1",
        `    key_env: ${envVar}`,
        "    transport: codex_responses",
        "    models: [current-model]",
        "custom_providers:",
        "  - name: acme",
        "    base_url: https://legacy.example.test/v1",
        `    key_env: ${legacyEnvVar}`,
        "    models: [legacy-model]",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(source, ".env"), `${envVar}=placeholder\n`);

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
        includeSecrets: true,
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { api?: string; baseUrl?: string; models?: Array<{ id?: string }> }>
      | undefined;
    expect(providers?.acme).toEqual(
      expect.objectContaining({
        api: "openai-responses",
        baseUrl: "https://current.example.test/v1",
        models: [
          expect.objectContaining({ id: "current-model" }),
          expect.objectContaining({ id: "legacy-model" }),
        ],
      }),
    );
    expect(
      plan.items.some(
        (item) => item.kind === "manual" && item.message?.includes(legacyEnvVar) === true,
      ),
    ).toBe(false);
  });

  it("does not let a custom entry shadow a canonical Hermes provider", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: openai-codex",
        "  default: gpt-5.6",
        "providers:",
        "  openai-codex:",
        "    api: https://chatgpt.com/backend-api/codex",
        "    transport: codex_responses",
        "    models: [gpt-5.6]",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("openai/gpt-5.6");
    const providers = modelProviderValues(plan.items) as
      | Record<string, { api?: string }>
      | undefined;
    expect(providers?.openai?.api).toBe("openai-chatgpt-responses");
    expect(providers?.["openai-codex"]).toBeUndefined();
  });

  it("preserves the Hermes Moonshot China endpoint while aligning provider auth", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: kimi-coding-cn\n  default: kimi-k2.5\n",
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { baseUrl?: string }>
      | undefined;
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("moonshot/kimi-k2.5");
    expect(providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
  });

  it("maps the Hermes MiniMax China route to OpenClaw's canonical provider", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: minimax-cn\n  default: MiniMax-M2.7\n",
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<string, { api?: string; baseUrl?: string }>
      | undefined;
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe(
      "minimax/MiniMax-M2.7",
    );
    expect(providers?.minimax).toEqual(
      expect.objectContaining({
        api: "anthropic-messages",
        baseUrl: "https://api.minimaxi.com/anthropic",
      }),
    );
  });

  it("maps the native Kimi Coding endpoint to Anthropic Messages", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: custom:kimi-native",
        "  default: kimi-k2.5",
        "  base_url: https://api.kimi.com/coding/v1",
        "",
      ].join("\n"),
    );

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );
    const providers = modelProviderValues(plan.items) as
      | Record<
          string,
          { api?: string; baseUrl?: string; models?: Array<{ api?: string; baseUrl?: string }> }
        >
      | undefined;
    expect(providers?.["kimi-native"]).toEqual(
      expect.objectContaining({
        api: "anthropic-messages",
        baseUrl: "https://api.kimi.com/coding",
        models: [
          expect.objectContaining({
            api: "anthropic-messages",
            baseUrl: "https://api.kimi.com/coding",
          }),
        ],
      }),
    );
  });

  it("continues independent items after one late config conflict", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const config: Record<string, unknown> = {};
    await writeFile(
      path.join(source, "config.yaml"),
      "mcp_servers:\n  alpha:\n    command: alpha\n  beta:\n    command: beta\n",
    );
    await writeFile(path.join(source, "SOUL.md"), "# Hermes soul\n");
    const runtime = makeConfigRuntime(config);
    const provider = buildHermesMigrationProvider({ runtime });
    const ctx = makeContext({ source, stateDir, workspaceDir, config, runtime });
    const plan = await provider.plan(ctx);
    config.mcp = { servers: { alpha: { command: "late" } } };

    const result = await provider.apply(ctx, plan);
    expect(itemById(result.items, "config:mcp-server:alpha")?.status).toBe("conflict");
    expect(itemById(result.items, "config:mcp-server:beta")?.status).toBe("migrated");
    expect(itemById(result.items, "workspace:SOUL.md")?.status).toBe("migrated");
    expect(
      (config.mcp as { servers?: { beta?: { command?: string } } }).servers?.beta?.command,
    ).toBe("beta");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
