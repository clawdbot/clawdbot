import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildTalkTestProviderConfig,
  readTalkTestProviderApiKey as readTalkProviderApiKey,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../test-utils/talk-test-provider.js";
import {
  __testing as commandSecretGatewayTesting,
  resolveCommandSecretRefsViaGateway,
} from "./command-secret-gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

const { callGateway } = mocks;

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

describe("resolveCommandSecretRefsViaGateway", () => {
  function makeTalkProviderApiKeySecretRefConfig(envKey: string): OpenClawConfig {
    return buildTalkTestProviderConfig({ source: "env", provider: "default", id: envKey });
  }

  async function withEnvValue(
    envKey: string,
    value: string | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    const priorValue = process.env[envKey];
    if (value === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = value;
    }
    try {
      await fn();
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
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
      ],
      diagnostics: [],
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
      expect(result.targetStatesByPath).toEqual({
        "channels.discord.accounts.ops.token": "resolved_gateway",
      });
      expect(result.hadUnresolvedTargets).toBe(false);
    } finally {
      restoreDeps();
    }
  });

  it("fails fast when gateway-backed resolution is unavailable", async () => {
    const envKey = "TALK_API_KEY_FAILFAST";
    const priorValue = process.env[envKey];
    delete process.env[envKey];
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    try {
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
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  });

  it("falls back to local resolution when gateway secrets.resolve is unavailable", async () => {
    const priorValue = process.env.TALK_API_KEY;
    process.env.TALK_API_KEY = "local-fallback-key"; // pragma: allowlist secret
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    try {
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
    } finally {
      if (priorValue === undefined) {
        delete process.env.TALK_API_KEY;
      } else {
        process.env.TALK_API_KEY = priorValue;
      }
    }
  });

  it("falls back to local resolution for web search SecretRefs when gateway is unavailable", async () => {
    const restoreDeps = commandSecretGatewayTesting.setDepsForTest({
      collectConfigAssignments: ({ context }) => {
        context.assignments.push({
          path: "plugins.entries.google.config.webSearch.apiKey",
        } as never);
      },
      resolveManifestContractOwnerPluginId: (params) =>
        params.contract === "webSearchProviders" && params.value === "gemini"
          ? "google"
          : undefined,
    });
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
    const restoreDeps = commandSecretGatewayTesting.setDepsForTest({
      collectConfigAssignments: ({ context }) => {
        context.assignments.push({
          path: "plugins.entries.firecrawl.config.webFetch.apiKey",
        } as never);
      },
      resolveManifestContractOwnerPluginId: (params) =>
        params.contract === "webFetchProviders" && params.value === "firecrawl"
          ? "firecrawl"
          : undefined,
    });
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

  it("marks web SecretRefs inactive when the web surface is disabled during local fallback", async () => {
    const restoreDeps = commandSecretGatewayTesting.setDepsForTest({
      collectConfigAssignments: ({ context }) => {
        context.assignments.push({
          path: "plugins.entries.google.config.webSearch.apiKey",
        } as never);
      },
      resolveManifestContractOwnerPluginId: (params) =>
        params.contract === "webSearchProviders" && params.value === "gemini"
          ? "google"
          : undefined,
    });
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
    const priorLocallyRecoveredValue = process.env[locallyRecoveredKey];
    process.env[locallyRecoveredKey] = "recovered-locally";
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

    try {
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
    } finally {
      if (priorLocallyRecoveredValue === undefined) {
        delete process.env[locallyRecoveredKey];
      } else {
        process.env[locallyRecoveredKey] = priorLocallyRecoveredValue;
      }
    }
  });

  it("limits local fallback to targeted refs in read-only modes", async () => {
    const talkEnvKey = "TALK_API_KEY_TARGET_ONLY";
    const gatewayEnvKey = "GATEWAY_PASSWORD_UNRELATED";
    const priorTalkValue = process.env[talkEnvKey];
    const priorGatewayValue = process.env[gatewayEnvKey];
    process.env[talkEnvKey] = "target-only";
    delete process.env[gatewayEnvKey];
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));

    try {
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
    } finally {
      if (priorTalkValue === undefined) {
        delete process.env[talkEnvKey];
      } else {
        process.env[talkEnvKey] = priorTalkValue;
      }
      if (priorGatewayValue === undefined) {
        delete process.env[gatewayEnvKey];
      } else {
        process.env[gatewayEnvKey] = priorGatewayValue;
      }
    }
  });

  it("degrades unresolved refs in read-only operational mode", async () => {
    const envKey = "TALK_API_KEY_OPERATIONAL_MISSING";
    const priorValue = process.env[envKey];
    delete process.env[envKey];
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));

    try {
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
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  });
});
