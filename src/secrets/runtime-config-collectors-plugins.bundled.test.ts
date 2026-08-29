/** Tests bundled plugin config secret collectors. */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { findBundledPluginMetadataById } from "../plugins/bundled-plugin-metadata.js";
import { resolvePluginConfigContractsById } from "../plugins/config-contracts.js";
import { resolveSecretRefValues } from "./resolve.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import { applyResolvedAssignments, createResolverContext } from "./runtime-shared.js";

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

const explicitMainRoster: NonNullable<OpenClawConfig["agents"]> = {
  list: [{ id: "main", default: true }],
};
const isolatedEnv: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_TEST_HOME };

describe("collectPluginConfigAssignments bundled plugin manifests", () => {
  it("assigns each webhooks route SecretRef to its exact runtime owner", () => {
    expect(
      findBundledPluginMetadataById("webhooks", {
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      })?.manifest.configContracts?.secretInputs?.paths,
    ).toEqual([{ path: "routes.*.secret", expected: "string", ownerKind: "route" }]);
    const config = {
      agents: explicitMainRoster,
      plugins: {
        entries: {
          webhooks: {
            enabled: true,
            config: {
              routes: {
                zapier: {
                  sessionKey: "agent:main:main",
                  secret: envRef("WEBHOOK_SECRET"),
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig: config, env: isolatedEnv });

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["webhooks", "bundled"]]),
    });

    expect(context.assignments).toMatchObject([
      {
        path: "plugins.entries.webhooks.config.routes.zapier.secret",
        ownerKind: "route",
        ownerId: "plugins.entries.webhooks.config.routes.zapier.secret",
        requiredForGateway: false,
        disposition: "isolate",
      },
    ]);
    expect(context.assignments[0]?.ownerContractDigest).toBeTruthy();
  });

  it("collects Codex app-server SecretRefs from bundled manifest contracts", () => {
    expect(
      findBundledPluginMetadataById("codex", {
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      })?.manifest.configContracts?.secretInputs?.paths,
    ).toEqual([
      { path: "appServer.authToken", expected: "string" },
      { path: "appServer.headers.*", expected: "string" },
    ]);
    const config = {
      agents: explicitMainRoster,
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: {
                transport: "websocket",
                url: "wss://codex-app-server.example.internal/ws",
                authToken: "$CODEX_APP_SERVER_TOKEN",
                headers: {
                  Authorization: "Bearer literal-token",
                  "x-codex-client-session-token": envRef("CODEX_CLIENT_SESSION_TOKEN"),
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(
      resolvePluginConfigContractsById({
        config,
        workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)),
        env: isolatedEnv,
        fallbackToBundledMetadata: true,
        fallbackToBundledMetadataForResolvedBundled: true,
        pluginIds: ["codex"],
        fallbackBundledPluginIds: ["codex"],
      }).get("codex")?.configContracts.secretInputs?.paths,
    ).toEqual([
      { path: "appServer.authToken", expected: "string" },
      { path: "appServer.headers.*", expected: "string" },
    ]);
    const context = createResolverContext({
      sourceConfig: config,
      env: isolatedEnv,
    });

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["codex", "bundled"]]),
    });

    expect({
      assignments: context.assignments.map((assignment) => assignment.path).toSorted(),
      warnings: context.warnings,
    }).toEqual({
      assignments: [
        "plugins.entries.codex.config.appServer.authToken",
        "plugins.entries.codex.config.appServer.headers.x-codex-client-session-token",
      ],
      warnings: [],
    });

    context.assignments[0]?.apply("resolved-app-server-token");
    context.assignments[1]?.apply("resolved-session-token");
    expect(config.plugins?.entries?.codex?.config).toMatchObject({
      appServer: {
        authToken: "resolved-app-server-token",
        headers: {
          Authorization: "Bearer literal-token",
          "x-codex-client-session-token": "resolved-session-token",
        },
      },
    });
  });

  it("resolves only explicitly referenced Google web-search headers", async () => {
    expect(
      findBundledPluginMetadataById("google", {
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      })?.manifest.configContracts?.secretInputs?.paths,
    ).toEqual([{ path: "webSearch.headers.*", expected: "string" }]);
    const config = {
      agents: explicitMainRoster,
      plugins: {
        entries: {
          google: {
            enabled: true,
            config: {
              webSearch: {
                headers: {
                  "X-Routing-Target": "staging",
                  "X-Gateway-Token": envRef("GEMINI_GATEWAY_TOKEN"),
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const env = { ...isolatedEnv, GEMINI_GATEWAY_TOKEN: "resolved-gateway-token" };
    const context = createResolverContext({ sourceConfig: config, env });

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["google", "bundled"]]),
    });

    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "plugins.entries.google.config.webSearch.headers.X-Gateway-Token",
    ]);
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      { config, env, cache: context.cache },
    );
    applyResolvedAssignments({ assignments: context.assignments, resolved });
    expect(config.plugins?.entries?.google?.config).toMatchObject({
      webSearch: {
        headers: {
          "X-Routing-Target": "staging",
          "X-Gateway-Token": "resolved-gateway-token",
        },
      },
    });
  });

  it("materializes Tavily tool credentials from the plugin secret contract", async () => {
    expect(
      findBundledPluginMetadataById("tavily", {
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      })?.manifest.configContracts?.secretInputs?.paths,
    ).toEqual([{ path: "webSearch.apiKey", expected: "string", ownerKind: "capability" }]);
    const sourceConfig = {
      agents: explicitMainRoster,
      plugins: {
        entries: {
          tavily: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: envRef("TAVILY_API_KEY"),
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = structuredClone(sourceConfig);
    const env = { ...isolatedEnv, TAVILY_API_KEY: "resolved-tavily-key" };
    const context = createResolverContext({ sourceConfig, env });

    collectPluginConfigAssignments({
      config: runtimeConfig,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["tavily", "bundled"]]),
    });

    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "plugins.entries.tavily.config.webSearch.apiKey",
    ]);
    expect(context.assignments).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "plugins.entries.tavily.config.webSearch.apiKey",
        requiredForGateway: false,
        disposition: "isolate",
      },
    ]);
    expect(context.assignments[0]?.ownerContractDigest).toBeUndefined();
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      { config: sourceConfig, env, cache: context.cache },
    );
    applyResolvedAssignments({ assignments: context.assignments, resolved });
    expect(sourceConfig.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: { apiKey: envRef("TAVILY_API_KEY") },
    });
    expect(runtimeConfig.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: { apiKey: "resolved-tavily-key" },
    });
  });

  it("materializes Firecrawl dedicated-tool credentials from both capability paths", async () => {
    expect(
      findBundledPluginMetadataById("firecrawl", {
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      })?.manifest.configContracts?.secretInputs?.paths,
    ).toEqual([
      { path: "webSearch.apiKey", expected: "string", ownerKind: "capability" },
      { path: "webFetch.apiKey", expected: "string", ownerKind: "capability" },
    ]);
    const sourceConfig = {
      agents: explicitMainRoster,
      plugins: {
        entries: {
          firecrawl: {
            enabled: true,
            config: {
              webSearch: { apiKey: envRef("FIRECRAWL_SEARCH_KEY") },
              webFetch: { apiKey: envRef("FIRECRAWL_FETCH_KEY") },
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = structuredClone(sourceConfig);
    const env = {
      ...isolatedEnv,
      FIRECRAWL_SEARCH_KEY: "resolved-search-key",
      FIRECRAWL_FETCH_KEY: "resolved-fetch-key",
    };
    const context = createResolverContext({ sourceConfig, env });
    collectPluginConfigAssignments({
      config: runtimeConfig,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["firecrawl", "bundled"]]),
    });
    expect(context.assignments.map((assignment) => assignment.path).toSorted()).toEqual([
      "plugins.entries.firecrawl.config.webFetch.apiKey",
      "plugins.entries.firecrawl.config.webSearch.apiKey",
    ]);
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      { config: sourceConfig, env, cache: context.cache },
    );
    applyResolvedAssignments({ assignments: context.assignments, resolved });
    expect(runtimeConfig.plugins?.entries?.firecrawl?.config).toMatchObject({
      webSearch: { apiKey: "resolved-search-key" },
      webFetch: { apiKey: "resolved-fetch-key" },
    });
  });

  it("collects voice-call SecretRef assignments from bundled manifest contracts", () => {
    expect(
      findBundledPluginMetadataById("voice-call", {
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      })?.manifest.configContracts?.secretInputs?.paths,
    ).toEqual([
      { path: "twilio.authToken", expected: "string" },
      { path: "realtime.providers.*.apiKey", expected: "string" },
      { path: "streaming.providers.*.apiKey", expected: "string" },
      { path: "tts.providers.*.apiKey", expected: "string" },
    ]);
    const config = {
      agents: explicitMainRoster,
      plugins: {
        entries: {
          "voice-call": {
            enabled: true,
            config: {
              twilio: {
                authToken: envRef("TWILIO_AUTH_TOKEN"),
              },
              realtime: {
                providers: {
                  google: {
                    apiKey: envRef("GEMINI_API_KEY"),
                  },
                },
              },
              streaming: {
                providers: {
                  openai: {
                    apiKey: envRef("OPENAI_API_KEY"),
                  },
                },
              },
              tts: {
                providers: {
                  openai: {
                    apiKey: envRef("OPENAI_API_KEY"),
                  },
                  elevenlabs: {
                    apiKey: envRef("ELEVENLABS_API_KEY"),
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(
      resolvePluginConfigContractsById({
        config,
        workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)),
        env: isolatedEnv,
        fallbackToBundledMetadata: true,
        fallbackToBundledMetadataForResolvedBundled: true,
        pluginIds: ["voice-call"],
        fallbackBundledPluginIds: ["voice-call"],
      }).get("voice-call")?.configContracts.secretInputs?.paths,
    ).toEqual([
      { path: "twilio.authToken", expected: "string" },
      { path: "realtime.providers.*.apiKey", expected: "string" },
      { path: "streaming.providers.*.apiKey", expected: "string" },
      { path: "tts.providers.*.apiKey", expected: "string" },
    ]);
    const context = createResolverContext({
      sourceConfig: config,
      env: isolatedEnv,
    });

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["voice-call", "bundled"]]),
    });

    expect({
      assignments: context.assignments.map((assignment) => assignment.path).toSorted(),
      warnings: context.warnings,
    }).toEqual({
      assignments: [
        "plugins.entries.voice-call.config.realtime.providers.google.apiKey",
        "plugins.entries.voice-call.config.streaming.providers.openai.apiKey",
        "plugins.entries.voice-call.config.tts.providers.elevenlabs.apiKey",
        "plugins.entries.voice-call.config.tts.providers.openai.apiKey",
        "plugins.entries.voice-call.config.twilio.authToken",
      ],
      warnings: [],
    });
  });

  it("collects google-meet realtime provider SecretRefs from its installed manifest", () => {
    const googleMeetPluginDir = fileURLToPath(
      new URL("../../extensions/google-meet", import.meta.url),
    );
    const config = {
      agents: explicitMainRoster,
      plugins: {
        load: { paths: [googleMeetPluginDir] },
        entries: {
          "google-meet": {
            enabled: true,
            config: {
              realtime: {
                providers: {
                  google: {
                    apiKey: envRef("GEMINI_API_KEY"),
                  },
                  openai: {
                    apiKey: envRef("OPENAI_API_KEY"),
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(
      resolvePluginConfigContractsById({
        config,
        env: isolatedEnv,
        pluginIds: ["google-meet"],
      }).get("google-meet")?.configContracts.secretInputs?.paths,
    ).toEqual([{ path: "realtime.providers.*.apiKey", expected: "string" }]);
    const context = createResolverContext({
      sourceConfig: config,
      env: isolatedEnv,
    });

    collectPluginConfigAssignments({
      config,
      defaults: undefined,
      context,
      loadablePluginOrigins: new Map([["google-meet", "config"]]),
    });

    expect({
      assignments: context.assignments.map((assignment) => assignment.path).toSorted(),
      warnings: context.warnings,
    }).toEqual({
      assignments: [
        "plugins.entries.google-meet.config.realtime.providers.google.apiKey",
        "plugins.entries.google-meet.config.realtime.providers.openai.apiKey",
      ],
      warnings: [],
    });
  });
});
