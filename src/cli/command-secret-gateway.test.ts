// Command secret gateway tests cover secret resolution for gateway-backed CLI commands.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildTalkTestProviderConfig,
  readTalkTestProviderApiKey as readTalkProviderApiKey,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../test-utils/talk-test-provider.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";
import { testing as commandSecretGatewayTesting } from "./command-secret-gateway.test-support.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

const { callGateway } = mocks;
const tempRoots = new Set<string>();

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../secrets/runtime-web-tools.js", () => ({
  resolveRuntimeWebTools: vi.fn(async () => ({})),
}));

vi.mock("../utils/message-channel.js", () => ({
  GATEWAY_CLIENT_MODES: { CLI: "cli" },
  GATEWAY_CLIENT_NAMES: { CLI: "cli" },
}));

beforeEach(() => {
  callGateway.mockReset();
  commandSecretGatewayTesting.resetDepsForTest();
});

afterEach(async () => {
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("resolveCommandSecretRefsViaGateway", () => {
  function makeTalkProviderApiKeySecretRefConfig(envKey: string): OpenClawConfig {
    return buildTalkTestProviderConfig({ source: "env", provider: "default", id: envKey });
  }

  async function withEnvValue(
    envKey: string,
    value: string | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    await withEnvAsync({ [envKey]: value }, fn);
  }

  async function resolveTalkProviderApiKey(params: {
    envKey: string;
    commandName?: string;
    mode?: "enforce_resolved" | "read_only_status";
  }) {
    return resolveCommandSecretRefsViaGateway({
      config: makeTalkProviderApiKeySecretRefConfig(params.envKey),
      commandName: params.commandName ?? "memory status",
      targetIds: new Set(["talk.providers.*.apiKey"]),
      mode: params.mode,
    });
  }

  function expectTalkProviderApiKeySecretRef(
    result: Awaited<ReturnType<typeof resolveTalkProviderApiKey>>,
    envKey: string,
  ) {
    expect(readTalkProviderApiKey(result.resolvedConfig)).toEqual({
      source: "env",
      provider: "default",
      id: envKey,
    });
  }

  function expectGatewayUnavailableLocalFallbackDiagnostics(
    result: Awaited<ReturnType<typeof resolveCommandSecretRefsViaGateway>>,
  ) {
    expect(
      result.diagnostics.some((entry) => entry.includes("gateway secrets.resolve unavailable")),
    ).toBe(true);
    expect(
      result.diagnostics.some((entry) => entry.includes("resolved command secrets locally")),
    ).toBe(true);
  }

  async function createExecProviderConfig(refId: string): Promise<{
    config: OpenClawConfig;
    markerPath: string;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-secret-exec-"));
    tempRoots.add(root);
    const markerPath = path.join(root, "executed");
    const resolverScript = [
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(stdin);",
      "  fs.writeFileSync(process.env.OPENCLAW_EXEC_MARKER, 'executed');",
      "  const values = Object.fromEntries(request.ids.map((id) => [id, 'exec-local-key']));",
      "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
      "});",
    ].join("\n");
    return {
      markerPath,
      config: {
        ...buildTalkTestProviderConfig({
          source: "exec",
          provider: "default",
          id: refId,
        }),
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
              args: ["-e", resolverScript],
              env: { OPENCLAW_EXEC_MARKER: markerPath },
              allowInsecurePath: true,
              allowSymlinkCommand: true,
              jsonOnly: true,
            },
          },
        },
      } as OpenClawConfig,
    };
  }

  async function markerExists(markerPath: string): Promise<boolean> {
    return await fs.access(markerPath).then(
      () => true,
      () => false,
    );
  }

  function readPath(root: unknown, pathSegments: readonly string[]): unknown {
    let cursor = root;
    for (const segment of pathSegments) {
      if (!cursor || typeof cursor !== "object") {
        return undefined;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  }

  function setSingleSecretTargetDeps(params: {
    path: string;
    pathSegments: readonly string[];
    resolveManifestContractOwnerPluginId?: NonNullable<
      Parameters<
        typeof commandSecretGatewayTesting.setDepsForTest
      >[0]["resolveManifestContractOwnerPluginId"]
    >;
  }): () => void {
    const deps: Parameters<typeof commandSecretGatewayTesting.setDepsForTest>[0] = {
      analyzeCommandSecretAssignmentsFromSnapshot: ({ inactiveRefPaths, resolvedConfig }) => {
        const value = readPath(resolvedConfig, params.pathSegments);
        const resolved = typeof value === "string" && value.length > 0;
        const inactive = Boolean(inactiveRefPaths?.has(params.path));
        return {
          assignments: resolved
            ? [
                {
                  path: params.path,
                  pathSegments: [...params.pathSegments],
                  value,
                },
              ]
            : [],
          diagnostics: [],
          inactive: inactive
            ? [
                {
                  path: params.path,
                  pathSegments: [...params.pathSegments],
                },
              ]
            : [],
          unresolved:
            resolved || inactive
              ? []
              : [
                  {
                    path: params.path,
                    pathSegments: [...params.pathSegments],
                  },
                ],
        } as never;
      },
      collectConfigAssignments: ({ context }) => {
        context.assignments.push({ path: params.path } as never);
      },
      discoverConfigSecretTargetsByIds: (config) =>
        [
          {
            entry: { expectedResolvedValue: "string" },
            path: params.path,
            pathSegments: [...params.pathSegments],
            value: readPath(config, params.pathSegments),
          },
        ] as never,
    };
    if (params.resolveManifestContractOwnerPluginId) {
      deps.resolveManifestContractOwnerPluginId = params.resolveManifestContractOwnerPluginId;
    }
    return commandSecretGatewayTesting.setDepsForTest(deps);
  }

  function setFirecrawlWebSearchTargetDeps(): () => void {
    return setSingleSecretTargetDeps({
      path: "plugins.entries.firecrawl.config.webSearch.apiKey",
      pathSegments: ["plugins", "entries", "firecrawl", "config", "webSearch", "apiKey"],
    });
  }

  function setFirecrawlWebFetchTargetDeps(): () => void {
    return setSingleSecretTargetDeps({
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
      pathSegments: ["plugins", "entries", "firecrawl", "config", "webFetch", "apiKey"],
      resolveManifestContractOwnerPluginId: (params) =>
        params.contract === "webFetchProviders" && params.value === "firecrawl"
          ? "firecrawl"
          : undefined,
    });
  }

  function setGoogleWebSearchTargetDeps(): () => void {
    return setSingleSecretTargetDeps({
      path: "plugins.entries.google.config.webSearch.apiKey",
      pathSegments: ["plugins", "entries", "google", "config", "webSearch", "apiKey"],
      resolveManifestContractOwnerPluginId: (params) =>
        params.contract === "webSearchProviders" && params.value === "gemini"
          ? "google"
          : undefined,
    });
  }

  it("returns config unchanged when no target SecretRefs are configured", async () => {
    const config = {
      ...buildTalkTestProviderConfig("plain"), // pragma: allowlist secret
    } as unknown as OpenClawConfig;
    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "memory status",
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });
    expect(result.resolvedConfig).toEqual(config);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("skips gateway resolution when all configured target refs are inactive", async () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            memorySearch: {
              enabled: false,
              remote: {
                apiKey: { source: "env", provider: "default", id: "AGENT_MEMORY_API_KEY" },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "status",
      targetIds: new Set(["agents.list[].memorySearch.remote.apiKey"]),
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(result.resolvedConfig).toEqual(config);
    expect(result.diagnostics).toEqual([
      "agents.list.0.memorySearch.remote.apiKey: agent or memorySearch override is disabled.",
    ]);
  });

  it("hydrates requested SecretRef targets from gateway snapshot assignments", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk-live",
        },
      ],
      diagnostics: [],
    });
    const config = buildTalkTestProviderConfig({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "memory status",
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });
    const gatewayRequest = callGateway.mock.calls[0]?.[0];
    expect(gatewayRequest?.config).toBe(config);
    expect(gatewayRequest?.method).toBe("secrets.resolve");
    expect(gatewayRequest?.requiredMethods).toEqual(["secrets.resolve"]);
    expect(gatewayRequest?.params).toEqual({
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("sk-live");
  });

  it("enforces unresolved checks only for allowed paths when provided", async () => {
    const restoreDeps = commandSecretGatewayTesting.setDepsForTest({
      analyzeCommandSecretAssignmentsFromSnapshot: () =>
        ({
          assignments: [
            {
              path: "channels.discord.accounts.ops.token",
              pathSegments: ["channels", "discord", "accounts", "ops", "token"],
              value: "ops-token",
            },
          ],
          diagnostics: [],
          inactive: [],
          unresolved: [],
        }) as never,
      collectConfigAssignments: ({ context }) => {
        context.assignments.push(
          { path: "channels.discord.accounts.ops.token" } as never,
          { path: "channels.discord.accounts.chat.token" } as never,
        );
      },
      discoverConfigSecretTargetsByIds: () =>
        [
          {
            entry: { expectedResolvedValue: "string" },
            path: "channels.discord.accounts.ops.token",
            pathSegments: ["channels", "discord", "accounts", "ops", "token"],
            value: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" },
          },
          {
            entry: { expectedResolvedValue: "string" },
            path: "channels.discord.accounts.chat.token",
            pathSegments: ["channels", "discord", "accounts", "chat", "token"],
            value: { source: "env", provider: "default", id: "DISCORD_CHAT_TOKEN" },
          },
        ] as never,
    });
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "channels.discord.accounts.ops.token",
          pathSegments: ["channels", "discord", "accounts", "ops", "token"],
          value: "ops-token",
        },
        {
          path: "channels.discord.accounts.chat.token",
          pathSegments: ["channels", "discord", "accounts", "chat", "token"],
          value: "chat-token",
        },
      ],
      diagnostics: [
        "channels.discord.accounts.ops.token: gateway note",
        "channels.discord.accounts.chat.token: gateway note",
      ],
    });

    try {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          channels: {
            discord: {
              accounts: {
                ops: {
                  token: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" },
                },
                chat: {
                  token: { source: "env", provider: "default", id: "DISCORD_CHAT_TOKEN" },
                },
              },
            },
          },
        } as OpenClawConfig,
        commandName: "message",
        targetIds: new Set(["channels.discord.accounts.*.token"]),
        allowedPaths: new Set(["channels.discord.accounts.ops.token"]),
      });

      expect(result.resolvedConfig.channels?.discord?.accounts?.ops?.token).toBe("ops-token");
      expect(result.resolvedConfig.channels?.discord?.accounts?.chat?.token).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_CHAT_TOKEN",
      });
      expect(result.targetStatesByPath).toEqual({
        "channels.discord.accounts.ops.token": "resolved_gateway",
      });
      expect(callGateway.mock.calls[0]?.[0].params).toEqual({
        commandName: "message",
        targetIds: ["channels.discord.accounts.*.token"],
        allowedPaths: ["channels.discord.accounts.ops.token"],
      });
      expect(result.diagnostics).toEqual(["channels.discord.accounts.ops.token: gateway note"]);
      expect(result.hadUnresolvedTargets).toBe(false);
    } finally {
      restoreDeps();
    }
  });

  it("retries old gateways without allowed paths and still filters scoped results", async () => {
    const restoreDeps = commandSecretGatewayTesting.setDepsForTest({
      analyzeCommandSecretAssignmentsFromSnapshot: () =>
        ({
          assignments: [
            {
              path: "channels.discord.accounts.ops.token",
              pathSegments: ["channels", "discord", "accounts", "ops", "token"],
              value: "ops-token",
            },
          ],
          diagnostics: [],
          inactive: [],
          unresolved: [],
        }) as never,
      collectConfigAssignments: ({ context }) => {
        context.assignments.push(
          { path: "channels.discord.accounts.ops.token" } as never,
          { path: "channels.discord.accounts.chat.token" } as never,
        );
      },
      discoverConfigSecretTargetsByIds: () =>
        [
          {
            entry: { expectedResolvedValue: "string" },
            path: "channels.discord.accounts.ops.token",
            pathSegments: ["channels", "discord", "accounts", "ops", "token"],
            value: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" },
          },
          {
            entry: { expectedResolvedValue: "string" },
            path: "channels.discord.accounts.chat.token",
            pathSegments: ["channels", "discord", "accounts", "chat", "token"],
            value: { source: "env", provider: "default", id: "DISCORD_CHAT_TOKEN" },
          },
        ] as never,
    });
    callGateway
      .mockRejectedValueOnce(
        new Error("secrets.resolve invalid request: invalid secrets.resolve params"),
      )
      .mockResolvedValueOnce({
        assignments: [
          {
            path: "channels.discord.accounts.ops.token",
            pathSegments: ["channels", "discord", "accounts", "ops", "token"],
            value: "ops-token",
          },
          {
            path: "channels.discord.accounts.chat.token",
            pathSegments: ["channels", "discord", "accounts", "chat", "token"],
            value: "chat-token",
          },
        ],
        diagnostics: [
          "channels.discord.accounts.ops.token: gateway note",
          "channels.discord.accounts.chat.token: gateway note",
        ],
      });

    try {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          channels: {
            discord: {
              accounts: {
                ops: {
                  token: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" },
                },
                chat: {
                  token: { source: "env", provider: "default", id: "DISCORD_CHAT_TOKEN" },
                },
              },
            },
          },
        } as OpenClawConfig,
        commandName: "message",
        targetIds: new Set(["channels.discord.accounts.*.token"]),
        allowedPaths: new Set(["channels.discord.accounts.ops.token"]),
      });

      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(callGateway.mock.calls[0]?.[0].params).toEqual({
        commandName: "message",
        targetIds: ["channels.discord.accounts.*.token"],
        allowedPaths: ["channels.discord.accounts.ops.token"],
      });
      expect(callGateway.mock.calls[1]?.[0].params).toEqual({
        commandName: "message",
        targetIds: ["channels.discord.accounts.*.token"],
      });
      expect(result.resolvedConfig.channels?.discord?.accounts?.ops?.token).toBe("ops-token");
      expect(result.resolvedConfig.channels?.discord?.accounts?.chat?.token).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_CHAT_TOKEN",
      });
      expect(result.targetStatesByPath).toEqual({
        "channels.discord.accounts.ops.token": "resolved_gateway",
      });
      expect(result.diagnostics).toEqual(["channels.discord.accounts.ops.token: gateway note"]);
      expect(result.hadUnresolvedTargets).toBe(false);
    } finally {
      restoreDeps();
    }
  });

  it("does not retry old gateways without forced active path support", async () => {
    const restoreDeps = setFirecrawlWebSearchTargetDeps();
    const envKey = "WEB_SEARCH_FIRECRAWL_OLD_GATEWAY_ONLY";
    try {
      await withEnvValue(envKey, undefined, async () => {
        callGateway.mockRejectedValueOnce(
          new Error("secrets.resolve invalid request: invalid secrets.resolve params"),
        );

        await expect(
          resolveCommandSecretRefsViaGateway({
            config: {
              tools: {
                web: {
                  search: {
                    provider: "exa",
                  },
                },
              },
              plugins: {
                entries: {
                  firecrawl: {
                    config: {
                      webSearch: {
                        apiKey: { source: "env", provider: "default", id: envKey },
                      },
                    },
                  },
                },
              },
            } as unknown as OpenClawConfig,
            commandName: "infer web search",
            targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
            allowedPaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
            forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
          }),
        ).rejects.toThrow(/does not support command-scoped secret resolution/i);
        expect(callGateway).toHaveBeenCalledTimes(1);
      });
    } finally {
      restoreDeps();
    }
  });

  it("fails fast when gateway-backed resolution is unavailable", async () => {
    const envKey = "TALK_API_KEY_FAILFAST";
    await withEnvValue(envKey, undefined, async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      await expect(
        resolveCommandSecretRefsViaGateway({
          config: buildTalkTestProviderConfig({
            source: "env",
            provider: "default",
            id: envKey,
          }),
          commandName: "memory status",
          targetIds: new Set(["talk.providers.*.apiKey"]),
        }),
      ).rejects.toThrow(/failed to resolve secrets from the active gateway snapshot/i);
    });
  });

  it("falls back to local resolution when gateway secrets.resolve is unavailable", async () => {
    await withEnvValue("TALK_API_KEY", "local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          ...buildTalkTestProviderConfig({
            source: "env",
            provider: "default",
            id: "TALK_API_KEY",
          }),
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as unknown as OpenClawConfig,
        commandName: "memory status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      });

      expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("local-fallback-key");
      expect(
        result.diagnostics.some((entry) => entry.includes("gateway secrets.resolve unavailable")),
      ).toBe(true);
      expect(
        result.diagnostics.some((entry) => entry.includes("resolved command secrets locally")),
      ).toBe(true);
    });
  });

  it("keeps local exec SecretRef fallback enabled by default", async () => {
    const { config, markerPath } = await createExecProviderConfig("talk/providers/api-key");
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "memory status",
      targetIds: new Set(["talk.providers.*.apiKey"]),
      mode: "read_only_status",
    });

    expect(await markerExists(markerPath)).toBe(true);
    expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("exec-local-key");
    expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
    expectGatewayUnavailableLocalFallbackDiagnostics(result);
  });

  it("skips local exec SecretRef fallback when the caller disallows exec providers", async () => {
    const { config, markerPath } = await createExecProviderConfig("talk/providers/api-key");
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "doctor preview",
      targetIds: new Set(["talk.providers.*.apiKey"]),
      mode: "read_only_status",
      allowLocalExecSecretRefs: false,
    });

    expect(await markerExists(markerPath)).toBe(false);
    expect(readTalkProviderApiKey(result.resolvedConfig)).toBeUndefined();
    expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("unresolved");
    expect(result.diagnostics).toContain(
      `doctor preview: ${TALK_TEST_PROVIDER_API_KEY_PATH} is unavailable in this command path; continuing with degraded read-only config.`,
    );
    expect(
      result.diagnostics.some((entry) =>
        entry.includes(
          "doctor preview: skipped local exec SecretRef resolution for talk.providers.acme-speech.apiKey",
        ),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some((entry) =>
        entry.includes("attempted local command-secret resolution"),
      ),
    ).toBe(true);
  });

  it("can preserve unresolved SecretRefs when local exec fallback is disabled", async () => {
    const { config, markerPath } = await createExecProviderConfig("talk/providers/api-key");
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "doctor preview",
      targetIds: new Set(["talk.providers.*.apiKey"]),
      mode: "read_only_status",
      allowLocalExecSecretRefs: false,
      scrubUnresolvedSecretRefs: false,
    });

    expect(await markerExists(markerPath)).toBe(false);
    expect(readTalkProviderApiKey(result.resolvedConfig)).toEqual({
      source: "exec",
      provider: "default",
      id: "talk/providers/api-key",
    });
    expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("unresolved");
    expect(result.hadUnresolvedTargets).toBe(true);
  });

  it("skips gateway resolution when gateway credentials would execute exec SecretRefs", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        TALK_API_KEY: "local-fallback-key",
      },
      async () => {
        const result = await resolveCommandSecretRefsViaGateway({
          config: {
            ...buildTalkTestProviderConfig({
              source: "env",
              provider: "env",
              id: "TALK_API_KEY",
            }),
            gateway: {
              auth: {
                mode: "token",
                token: { source: "exec", provider: "vault", id: "gateway/token" },
              },
            },
            secrets: {
              providers: {
                env: { source: "env" },
                vault: {
                  source: "exec",
                  command: process.execPath,
                  args: ["-e", 'process.stdout.write(\'{"values":{"gateway/token":"x"}}\')'],
                  allowInsecurePath: true,
                  allowSymlinkCommand: true,
                  jsonOnly: true,
                },
              },
            },
          } as OpenClawConfig,
          commandName: "doctor preview",
          targetIds: new Set(["talk.providers.*.apiKey"]),
          mode: "read_only_status",
          allowLocalExecSecretRefs: false,
        });

        expect(callGateway).not.toHaveBeenCalled();
        expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("local-fallback-key");
        expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
        expect(
          result.diagnostics.some((entry) =>
            entry.includes(
              "doctor preview: skipped gateway secrets.resolve because gateway credentials use exec SecretRefs at gateway.auth.token",
            ),
          ),
        ).toBe(true);
      },
    );
  });

  it("falls back to local resolution for web search SecretRefs when gateway is unavailable", async () => {
    const restoreDeps = setGoogleWebSearchTargetDeps();
    const envKey = "WEB_SEARCH_GEMINI_API_KEY_LOCAL_FALLBACK";
    await withEnvValue(envKey, "gemini-local-fallback-key", async () => {
      try {
        callGateway.mockRejectedValueOnce(new Error("gateway closed"));
        const result = await resolveCommandSecretRefsViaGateway({
          config: {
            plugins: {
              entries: {
                google: {
                  config: {
                    webSearch: {
                      apiKey: { source: "env", provider: "default", id: envKey },
                    },
                  },
                },
              },
            },
            tools: {
              web: {
                search: {
                  provider: "gemini",
                },
              },
            },
          } as unknown as OpenClawConfig,
          commandName: "agent",
          targetIds: new Set(["plugins.entries.google.config.webSearch.apiKey"]),
        });

        const googleWebSearchConfig = result.resolvedConfig.plugins?.entries?.google?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        expect(googleWebSearchConfig?.webSearch?.apiKey).toBe("gemini-local-fallback-key");
        expect(result.targetStatesByPath["plugins.entries.google.config.webSearch.apiKey"]).toBe(
          "resolved_local",
        );
        expectGatewayUnavailableLocalFallbackDiagnostics(result);
      } finally {
        restoreDeps();
      }
    });
  }, 300_000);

  it("falls back to local resolution for web fetch provider SecretRefs when gateway is unavailable", async () => {
    const restoreDeps = setFirecrawlWebFetchTargetDeps();
    const envKey = "WEB_FETCH_FIRECRAWL_API_KEY_LOCAL_FALLBACK";
    await withEnvValue(envKey, "firecrawl-local-fallback-key", async () => {
      try {
        callGateway.mockRejectedValueOnce(new Error("gateway closed"));
        const result = await resolveCommandSecretRefsViaGateway({
          config: {
            plugins: {
              entries: {
                firecrawl: {
                  config: {
                    webFetch: {
                      apiKey: { source: "env", provider: "default", id: envKey },
                    },
                  },
                },
              },
            },
            tools: {
              web: {
                fetch: {
                  provider: "firecrawl",
                },
              },
            },
          } as unknown as OpenClawConfig,
          commandName: "agent",
          targetIds: new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
        });

        const firecrawlConfig = result.resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined;
        expect(firecrawlConfig?.webFetch?.apiKey).toBe("firecrawl-local-fallback-key");
        expect(result.targetStatesByPath["plugins.entries.firecrawl.config.webFetch.apiKey"]).toBe(
          "resolved_local",
        );
        expectGatewayUnavailableLocalFallbackDiagnostics(result);
      } finally {
        restoreDeps();
      }
    });
  });

  it("falls back to local resolution for legacy web fetch SecretRefs", async () => {
    const envKey = "WEB_FETCH_LEGACY_FIRECRAWL_API_KEY_LOCAL_FALLBACK";
    await withEnvValue(envKey, "firecrawl-legacy-local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          tools: {
            web: {
              fetch: {
                provider: "firecrawl",
                firecrawl: {
                  apiKey: { source: "env", provider: "default", id: envKey },
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        commandName: "infer web fetch",
        targetIds: new Set(["tools.web.fetch.firecrawl.apiKey"]),
      });

      const fetchConfig = result.resolvedConfig.tools?.web?.fetch as
        | { firecrawl?: { apiKey?: unknown } }
        | undefined;
      expect(fetchConfig?.firecrawl?.apiKey).toBe("firecrawl-legacy-local-fallback-key");
      expect(result.targetStatesByPath["tools.web.fetch.firecrawl.apiKey"]).toBe("resolved_local");
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    });
  });

  it("keeps top-level web search SecretRefs on the direct local fallback path", async () => {
    const runtimeWebTools = await import("../secrets/runtime-web-tools.js");
    vi.mocked(runtimeWebTools.resolveRuntimeWebTools).mockClear();
    const envKey = "WEB_SEARCH_BRAVE_TOP_LEVEL_LOCAL_FALLBACK";
    await withEnvValue(envKey, "brave-top-level-local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          tools: {
            web: {
              search: {
                provider: "exa",
                apiKey: { source: "env", provider: "default", id: envKey },
              },
            },
          },
        } as unknown as OpenClawConfig,
        commandName: "infer web search",
        targetIds: new Set(["tools.web.search.apiKey"]),
        forcedActivePaths: new Set(["tools.web.search.apiKey"]),
      });

      expect(result.resolvedConfig.tools?.web?.search?.apiKey).toBe(
        "brave-top-level-local-fallback-key",
      );
      expect(result.targetStatesByPath["tools.web.search.apiKey"]).toBe("resolved_local");
      expect(runtimeWebTools.resolveRuntimeWebTools).not.toHaveBeenCalled();
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    });
  });

  it("treats command-scoped web fetch fallback SecretRefs as active even when web search is disabled", async () => {
    const restoreDeps = setFirecrawlWebSearchTargetDeps();
    const envKey = "WEB_FETCH_FIRECRAWL_SEARCH_FALLBACK_KEY";
    try {
      await withEnvValue(envKey, "firecrawl-search-fallback-key", async () => {
        callGateway.mockRejectedValueOnce(new Error("gateway closed"));
        const result = await resolveCommandSecretRefsViaGateway({
          config: {
            tools: {
              web: {
                search: {
                  enabled: false,
                  provider: "brave",
                },
                fetch: {
                  provider: "firecrawl",
                },
              },
            },
            plugins: {
              entries: {
                firecrawl: {
                  enabled: true,
                  config: {
                    webSearch: {
                      apiKey: { source: "env", provider: "default", id: envKey },
                    },
                  },
                },
              },
            },
          } as unknown as OpenClawConfig,
          commandName: "infer web fetch",
          targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
          allowedPaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
          forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
        });

        const firecrawlConfig = result.resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        expect(firecrawlConfig?.webSearch?.apiKey).toBe("firecrawl-search-fallback-key");
        expect(result.targetStatesByPath["plugins.entries.firecrawl.config.webSearch.apiKey"]).toBe(
          "resolved_local",
        );
        expectGatewayUnavailableLocalFallbackDiagnostics(result);
      });
    } finally {
      restoreDeps();
    }
  });

  it("drops gateway inactive diagnostics for forced active fallback paths", async () => {
    const restoreDeps = setFirecrawlWebSearchTargetDeps();
    const envKey = "WEB_FETCH_FIRECRAWL_FORCED_FALLBACK_KEY";
    try {
      await withEnvValue(envKey, "firecrawl-search-fallback-key", async () => {
        callGateway.mockResolvedValueOnce({
          assignments: [],
          diagnostics: [
            "plugins.entries.firecrawl.config.webSearch.apiKey: secret ref is configured on an inactive surface; tools.web.search is disabled.",
          ],
          inactiveRefPaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
        });
        const result = await resolveCommandSecretRefsViaGateway({
          config: {
            tools: {
              web: {
                search: {
                  enabled: false,
                  provider: "brave",
                },
                fetch: {
                  provider: "firecrawl",
                },
              },
            },
            plugins: {
              entries: {
                firecrawl: {
                  enabled: true,
                  config: {
                    webSearch: {
                      apiKey: { source: "env", provider: "default", id: envKey },
                    },
                  },
                },
              },
            },
          } as unknown as OpenClawConfig,
          commandName: "infer web fetch",
          targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
          allowedPaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
          forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
        });

        const firecrawlConfig = result.resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        expect(firecrawlConfig?.webSearch?.apiKey).toBe("firecrawl-search-fallback-key");
        expect(result.targetStatesByPath["plugins.entries.firecrawl.config.webSearch.apiKey"]).toBe(
          "resolved_local",
        );
        expect(callGateway.mock.calls[0]?.[0].params).toEqual({
          commandName: "infer web fetch",
          targetIds: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
          allowedPaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
          forcedActivePaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
        });
        expect(result.diagnostics).not.toContain(
          "plugins.entries.firecrawl.config.webSearch.apiKey: secret ref is configured on an inactive surface; tools.web.search is disabled.",
        );
      });
    } finally {
      restoreDeps();
    }
  });

  it("honors forced active paths for non-web local fallback targets", async () => {
    const envKey = "GOOGLE_MODEL_FALLBACK_API_KEY";
    await withEnvValue(envKey, "google-local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          models: {
            providers: {
              google: {
                enabled: false,
                apiKey: { source: "env", provider: "default", id: envKey },
              },
            },
          },
        } as unknown as OpenClawConfig,
        commandName: "infer web search",
        targetIds: new Set(["models.providers.*.apiKey"]),
        allowedPaths: new Set(["models.providers.google.apiKey"]),
        forcedActivePaths: new Set(["models.providers.google.apiKey"]),
      });

      expect(result.resolvedConfig.models?.providers?.google?.apiKey).toBe(
        "google-local-fallback-key",
      );
      expect(result.targetStatesByPath["models.providers.google.apiKey"]).toBe("resolved_local");
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    });
  });

  it("marks web SecretRefs inactive when the web surface is disabled during local fallback", async () => {
    const restoreDeps = setGoogleWebSearchTargetDeps();
    try {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          tools: {
            web: {
              search: {
                enabled: false,
                provider: "gemini",
              },
            },
          },
          plugins: {
            entries: {
              google: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "WEB_SEARCH_DISABLED_KEY",
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        commandName: "agent",
        targetIds: new Set(["plugins.entries.google.config.webSearch.apiKey"]),
      });

      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath["plugins.entries.google.config.webSearch.apiKey"]).toBe(
        "inactive_surface",
      );
      expect(
        result.diagnostics.some((entry) =>
          entry.includes(
            "plugins.entries.google.config.webSearch.apiKey: tools.web.search is disabled.",
          ),
        ),
      ).toBe(true);
    } finally {
      restoreDeps();
    }
  });

  it("returns a version-skew hint when gateway does not support secrets.resolve", async () => {
    const envKey = "TALK_API_KEY_UNSUPPORTED";
    callGateway.mockRejectedValueOnce(new Error("unknown method: secrets.resolve"));
    await withEnvValue(envKey, undefined, async () => {
      await expect(resolveTalkProviderApiKey({ envKey })).rejects.toThrow(
        /does not support secrets\.resolve/i,
      );
    });
  });

  it("returns a version-skew hint when required-method capability check fails", async () => {
    const envKey = "TALK_API_KEY_REQUIRED_METHOD";
    callGateway.mockRejectedValueOnce(
      new Error(
        'active gateway does not support required method "secrets.resolve" for "secrets.resolve".',
      ),
    );
    await withEnvValue(envKey, undefined, async () => {
      await expect(resolveTalkProviderApiKey({ envKey })).rejects.toThrow(
        /does not support secrets\.resolve/i,
      );
    });
  });

  it("fails when gateway returns an invalid secrets.resolve payload", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: "not-an-array",
      diagnostics: [],
    });
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: "TALK_API_KEY",
        }),
        commandName: "memory status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      }),
    ).rejects.toThrow(/invalid secrets\.resolve payload/i);
  });

  it("fails when gateway assignment path does not exist in local config", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "talk.providers.missing.apiKey",
          pathSegments: ["talk", "providers", "missing", "apiKey"],
          value: "sk-live",
        },
      ],
      diagnostics: [],
    });
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: "TALK_API_KEY",
        }),
        commandName: "memory status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      }),
    ).rejects.toThrow(
      "memory status: failed to apply resolved secret assignment at talk.providers.missing.apiKey",
    );
  });

  it("fails when configured refs remain unresolved after gateway assignments are applied", async () => {
    const envKey = "TALK_API_KEY_STRICT_UNRESOLVED";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });

    await withEnvValue(envKey, undefined, async () => {
      await expect(resolveTalkProviderApiKey({ envKey })).rejects.toThrow(
        new RegExp(
          `${TALK_TEST_PROVIDER_API_KEY_PATH.replaceAll(".", "\\.")} is unresolved in the active runtime snapshot`,
          "i",
        ),
      );
    });
  });

  it("allows unresolved refs when gateway diagnostics mark the target as inactive", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [
        `${TALK_TEST_PROVIDER_API_KEY_PATH}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
      ],
    });

    const result = await resolveTalkProviderApiKey({ envKey: "TALK_API_KEY" });

    expectTalkProviderApiKeySecretRef(result, "TALK_API_KEY");
    expect(result.diagnostics).toEqual([
      `${TALK_TEST_PROVIDER_API_KEY_PATH}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
    ]);
  });

  it("uses inactiveRefPaths from structured response without parsing diagnostic text", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: ["talk api key inactive"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });

    const result = await resolveTalkProviderApiKey({ envKey: "TALK_API_KEY" });

    expectTalkProviderApiKeySecretRef(result, "TALK_API_KEY");
    expect(result.diagnostics).toEqual(["talk api key inactive"]);
  });

  it("allows unresolved array-index refs when gateway marks concrete paths inactive", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: ["memory search ref inactive"],
      inactiveRefPaths: ["agents.list.0.memorySearch.remote.apiKey"],
    });

    const config = {
      agents: {
        list: [
          {
            id: "main",
            memorySearch: {
              remote: {
                apiKey: { source: "env", provider: "default", id: "MISSING_MEMORY_API_KEY" },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "memory status",
      targetIds: new Set(["agents.list[].memorySearch.remote.apiKey"]),
    });

    expect(result.resolvedConfig.agents?.list?.[0]?.memorySearch?.remote?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_MEMORY_API_KEY",
    });
    expect(result.diagnostics).toEqual(["memory search ref inactive"]);
  });

  it("degrades unresolved refs in read-only status mode instead of throwing", async () => {
    const envKey = "TALK_API_KEY_SUMMARY_MISSING";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await withEnvValue(envKey, undefined, async () => {
      const result = await resolveTalkProviderApiKey({
        envKey,
        commandName: "status",
        mode: "read_only_status",
      });
      expect(readTalkProviderApiKey(result.resolvedConfig)).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("unresolved");
      expect(
        result.diagnostics.some((entry) =>
          entry.includes(`${TALK_TEST_PROVIDER_API_KEY_PATH} is unavailable in this command path`),
        ),
      ).toBe(true);
    });
  });

  it("accepts legacy summary mode as a read-only alias", async () => {
    const envKey = "TALK_API_KEY_LEGACY_SUMMARY_MISSING";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await withEnvValue(envKey, undefined, async () => {
      const result = await resolveCommandSecretRefsViaGateway({
        config: makeTalkProviderApiKeySecretRefConfig(envKey),
        commandName: "status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
        mode: "summary",
      });
      expect(readTalkProviderApiKey(result.resolvedConfig)).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("unresolved");
    });
  });

  it("uses targeted local fallback after an incomplete gateway snapshot", async () => {
    const envKey = "TALK_API_KEY_PARTIAL_GATEWAY";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await withEnvValue(envKey, "recovered-locally", async () => {
      const result = await resolveTalkProviderApiKey({
        envKey,
        commandName: "status",
        mode: "read_only_status",
      });
      expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("recovered-locally");
      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
      expect(
        result.diagnostics.some((entry) =>
          entry.includes(
            "resolved 1 secret path locally after the gateway snapshot was incomplete",
          ),
        ),
      ).toBe(true);
    });
  });

  it("limits strict local fallback analysis to unresolved gateway paths", async () => {
    const locallyRecoveredKey = "TALK_API_KEY_PARTIAL_GATEWAY_LOCAL";
    await withEnvValue(locallyRecoveredKey, "recovered-locally", async () => {
      callGateway.mockResolvedValueOnce({
        assignments: [
          {
            path: TALK_TEST_PROVIDER_API_KEY_PATH,
            pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
            value: "resolved-by-gateway",
          },
        ],
        diagnostics: [],
      });
      const result = await resolveCommandSecretRefsViaGateway({
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: locallyRecoveredKey,
        }),
        commandName: "message send",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      });

      expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("resolved-by-gateway");
      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_gateway");
    });
  });

  it("preserves gateway assignments while resolving only missing paths locally", async () => {
    const localEnvKey = "TALK_API_KEY_PARTIAL_LOCAL";
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "talk.providers.gateway.apiKey",
          pathSegments: ["talk", "providers", "gateway", "apiKey"],
          value: "gateway-owned-key",
        },
      ],
      diagnostics: [],
    });
    await withEnvAsync({ [localEnvKey]: "local-fallback-key" }, async () => {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            providers: {
              gateway: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "GATEWAY_ONLY_TALK_KEY",
                },
              },
              local: {
                apiKey: { source: "env", provider: "default", id: localEnvKey },
              },
            },
          },
        } as OpenClawConfig,
        commandName: "reply",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      });

      expect(result.resolvedConfig.talk?.providers?.gateway?.apiKey).toBe("gateway-owned-key");
      expect(result.resolvedConfig.talk?.providers?.local?.apiKey).toBe("local-fallback-key");
      expect(result.targetStatesByPath).toMatchObject({
        "talk.providers.gateway.apiKey": "resolved_gateway",
        "talk.providers.local.apiKey": "resolved_local",
      });
      expect(
        result.diagnostics.some((entry) => entry.includes("gateway secrets.resolve unavailable")),
      ).toBe(false);
    });
  });

  it("limits local fallback to targeted refs in read-only modes", async () => {
    const talkEnvKey = "TALK_API_KEY_TARGET_ONLY";
    const gatewayEnvKey = "GATEWAY_PASSWORD_UNRELATED";
    await withEnvAsync({ [talkEnvKey]: "target-only", [gatewayEnvKey]: undefined }, async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          ...buildTalkTestProviderConfig({
            source: "env",
            provider: "default",
            id: talkEnvKey,
          }),
          gateway: {
            auth: {
              password: { source: "env", provider: "default", id: gatewayEnvKey },
            },
          },
        } as unknown as OpenClawConfig,
        commandName: "status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
        mode: "read_only_status",
      });

      expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("target-only");
      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
    });
  });

  it("degrades unresolved refs in read-only operational mode", async () => {
    const envKey = "TALK_API_KEY_OPERATIONAL_MISSING";
    await withEnvValue(envKey, undefined, async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: envKey,
        }),
        commandName: "channels resolve",
        targetIds: new Set(["talk.providers.*.apiKey"]),
        mode: "read_only_operational",
      });

      expect(readTalkProviderApiKey(result.resolvedConfig)).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("unresolved");
      expect(
        result.diagnostics.some((entry) =>
          entry.includes("attempted local command-secret resolution"),
        ),
      ).toBe(true);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
