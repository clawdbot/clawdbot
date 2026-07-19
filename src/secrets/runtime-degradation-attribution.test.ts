/** Tests degraded-owner attribution during runtime SecretRef preparation. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import type { SecretRef } from "../config/types.secrets.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import { listSecretResolutionErrorOwners } from "./runtime-degraded-state.js";
import {
  canonicalizeSecretRefsForOwnerContract,
  combineSecretOwnerContractDigests,
  digestSecretOwnerContract,
} from "./runtime-owner-contract.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const TTS_REF = {
  source: "env",
  provider: "default",
  id: "ELEVENLABS_API_KEY",
} as const;

describe("secrets runtime degraded-owner attribution", () => {
  it("fails closed for missing TTS SecretRefs outside cold-start isolation", async () => {
    const error = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            example: {
              apiKey: { source: "env", provider: "default", id: "CURRENT_PROVIDER_REF" },
              baseUrl: "https://example.invalid/v1",
              models: [],
            },
          },
        },
        messages: {
          tts: {
            providers: {
              elevenlabs: { apiKey: TTS_REF },
            },
          },
        },
      }),
      env: { CURRENT_PROVIDER_REF: "resolved" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      'Environment variable "ELEVENLABS_API_KEY" is missing or empty.',
    );
    expect(listSecretResolutionErrorOwners(error)).toEqual([
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "tts",
        paths: ["messages.tts.providers.elevenlabs.apiKey"],
        reason: "secret reference was not found",
        degradationState: "cold",
        failureMatched: true,
      }),
    ]);
  });

  it.each([
    ["CURRENT_REF", "stale"],
    ["CHANGED_REF", "cold"],
  ] as const)("classifies unresolved reload ref %s", async (candidateId, expectedState) => {
    const config = (ref: SecretRef) =>
      asConfig({ messages: { tts: { providers: { elevenlabs: { apiKey: ref } } } } });
    const ref = (id: string): SecretRef => ({ source: "env", provider: "default", id });
    const active = await prepareSecretsRuntimeSnapshot({
      config: config(ref("CURRENT_REF")),
      env: { CURRENT_REF: "resolved" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const error = await prepareSecretsRuntimeSnapshot({
      config: config(ref(candidateId)),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(listSecretResolutionErrorOwners(error)).toEqual([
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "tts",
        degradationState: expectedState,
      }),
    ]);
  });

  it.each([
    ["explicit", "WEB_TOOL_REF", "stale"],
    ["explicit", "CHANGED_WEB_TOOL_REF", "cold"],
    ["auto", "WEB_TOOL_REF", "stale"],
  ] as const)("classifies %s web tool ref %s", async (mode, candidateId, expectedState) => {
    const config = (id: string) =>
      asConfig({
        tools: {
          web: { search: mode === "explicit" ? { provider: "gemini" } : { enabled: true } },
        },
        plugins: {
          entries: {
            ...(mode === "auto"
              ? {
                  brave: {
                    config: {
                      webSearch: {
                        apiKey: { source: "env", provider: "default", id: "EARLIER_REF" },
                      },
                    },
                  },
                }
              : {}),
            google: {
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id } },
              },
            },
          },
        },
      });
    const active = await prepareSecretsRuntimeSnapshot({
      config: config("WEB_TOOL_REF"),
      env: { WEB_TOOL_REF: "resolved" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const error = await prepareSecretsRuntimeSnapshot({
      config: config(candidateId),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    const owners = listSecretResolutionErrorOwners(error);
    expect(owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "web-search:gemini",
          degradationState: expectedState,
          failureMatched: true,
        }),
      ]),
    );
    if (mode === "auto") {
      expect(owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ownerId: "web-search:brave",
            degradationState: "cold",
          }),
        ]),
      );
    }
  });

  it("attributes provider failures by source and provider before matching ref ids", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-secret-provider-owner-match-");
    const healthyPath = path.join(root, "healthy.json");
    await fs.writeFile(healthyPath, JSON.stringify({ shared: "healthy" }), "utf8");
    await fs.chmod(healthyPath, 0o600);
    const sharedId = "/shared";
    const error = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            missing: {
              source: "file",
              path: path.join(root, "missing.json"),
              mode: "json",
            },
            healthy: { source: "file", path: healthyPath, mode: "json" },
          },
        },
        models: {
          providers: {
            example: {
              apiKey: { source: "file", provider: "missing", id: sharedId },
              baseUrl: "https://example.invalid/v1",
              models: [],
            },
          },
        },
        messages: {
          tts: {
            providers: {
              elevenlabs: {
                apiKey: { source: "file", provider: "healthy", id: sharedId },
              },
            },
          },
        },
      }),
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(listSecretResolutionErrorOwners(error)).toEqual([
      expect.objectContaining({ ownerKind: "provider", ownerId: "example" }),
    ]);
  });

  it("includes active co-owners using another ref from a failed provider", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-secret-provider-active-co-owner-");
    const provider = "missing";
    const apiKeyRef = { source: "file" as const, provider, id: "/candidate" };
    const activeRef = { source: "file" as const, provider, id: "/active" };
    const config = asConfig({
      secrets: {
        providers: {
          [provider]: {
            source: "file",
            path: path.join(root, "missing.json"),
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          example: {
            apiKey: apiKeyRef,
            baseUrl: "https://example.invalid/v1",
            models: [],
          },
        },
      },
    });
    const agentDir = path.join(root, "agent");
    const profileId = "openai:provider-failure";
    const accountOwnerId = resolveAuthProfileSecretOwnerId({
      agentDir,
      profileId,
    });
    const active = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    active.sourceConfig = config;
    active.config = config;
    active.authStores = [
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "openai",
              key: "dummy",
              keyRef: activeRef,
            },
          },
        },
      },
    ];
    active.secretOwners = [
      {
        ownerKind: "account",
        ownerId: accountOwnerId,
        refKeys: ["file:missing:/active"],
        contractDigest: combineSecretOwnerContractDigests([
          digestSecretOwnerContract(
            canonicalizeSecretRefsForOwnerContract(
              {
                profile: {
                  type: "api_key",
                  provider: "openai",
                  key: "dummy",
                  keyRef: activeRef,
                },
                providerId: "openai",
                configuredProvider: undefined,
              },
              undefined,
            ),
          ),
        ]),
      },
    ];
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const error = await prepareSecretsRuntimeSnapshot({
      config,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(listSecretResolutionErrorOwners(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerKind: "provider", ownerId: "example" }),
        expect.objectContaining({
          ownerKind: "account",
          ownerId: accountOwnerId,
          degradationState: "stale",
          source: "auth-store",
          failureMatched: true,
        }),
      ]),
    );
  });

  it("includes active web-tool co-owners when strict resolution fails first", async () => {
    const sharedRef = { source: "env" as const, provider: "default", id: "SHARED_API_KEY" };
    const authAgentDir = "/tmp/shared-secret-co-owner";
    const authProfileId = "openai:shared";
    const authOwnerId = resolveAuthProfileSecretOwnerId({
      agentDir: authAgentDir,
      profileId: authProfileId,
    });
    const config = asConfig({
      models: {
        providers: {
          example: {
            apiKey: sharedRef,
            baseUrl: "https://example.invalid/v1",
            models: [],
          },
        },
      },
      tools: { web: { search: { provider: "gemini" } } },
      plugins: {
        entries: {
          google: { config: { webSearch: { apiKey: sharedRef } } },
        },
      },
    });
    const active = await prepareSecretsRuntimeSnapshot({
      config,
      env: { SHARED_API_KEY: "dummy" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    active.authStores = [
      {
        agentDir: authAgentDir,
        store: {
          version: 1,
          profiles: {
            [authProfileId]: {
              type: "api_key",
              provider: "openai",
              key: "dummy",
              keyRef: sharedRef,
            },
          },
        },
      },
    ];
    active.secretOwners?.push({
      ownerKind: "account",
      ownerId: authOwnerId,
      refKeys: ["env:default:SHARED_API_KEY"],
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const error = await prepareSecretsRuntimeSnapshot({
      config,
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(listSecretResolutionErrorOwners(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerKind: "provider", ownerId: "example" }),
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "web-search:gemini",
          degradationState: "stale",
          failureMatched: true,
        }),
        expect.objectContaining({
          ownerKind: "account",
          ownerId: authOwnerId,
          source: "auth-store",
          failureMatched: true,
        }),
      ]),
    );
  });

  it("includes active web-tool co-owners when a shared resolved value is invalid", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-invalid-web-co-owner-");
    const secretsPath = path.join(root, "secrets.json");
    await fs.writeFile(secretsPath, JSON.stringify({ shared: "dummy" }), "utf8");
    await fs.chmod(secretsPath, 0o600);
    const sharedRef = { source: "file" as const, provider: "shared", id: "/shared" };
    const config = asConfig({
      secrets: {
        providers: {
          shared: { source: "file", path: secretsPath, mode: "json" },
        },
      },
      models: {
        providers: {
          example: {
            apiKey: sharedRef,
            baseUrl: "https://example.invalid/v1",
            models: [],
          },
        },
      },
      tools: { web: { search: { provider: "gemini" } } },
      plugins: {
        entries: {
          google: { config: { webSearch: { apiKey: sharedRef } } },
        },
      },
    });
    const active = await prepareSecretsRuntimeSnapshot({
      config,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });
    await fs.writeFile(secretsPath, JSON.stringify({ shared: { invalid: true } }), "utf8");

    const error = await prepareSecretsRuntimeSnapshot({
      config,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(listSecretResolutionErrorOwners(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerKind: "provider", ownerId: "example" }),
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "web-search:gemini",
          reason: "resolved secret value was invalid",
          degradationState: "stale",
          failureMatched: true,
          source: "config",
        }),
      ]),
    );
  });

  it("includes later active web-tool co-owners when web resolution fails first", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-invalid-web-sibling-");
    const secretsPath = path.join(root, "secrets.json");
    await fs.writeFile(secretsPath, JSON.stringify({ shared: "dummy" }), "utf8");
    await fs.chmod(secretsPath, 0o600);
    const sharedRef = { source: "file" as const, provider: "shared", id: "/shared" };
    const config = asConfig({
      secrets: {
        providers: {
          shared: { source: "file", path: secretsPath, mode: "json" },
        },
      },
      tools: {
        web: {
          search: { provider: "gemini" },
          fetch: { provider: "firecrawl" },
        },
      },
      plugins: {
        entries: {
          google: { config: { webSearch: { apiKey: sharedRef } } },
          firecrawl: { config: { webFetch: { apiKey: sharedRef } } },
        },
      },
    });
    const active = await prepareSecretsRuntimeSnapshot({
      config,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });
    await fs.writeFile(secretsPath, JSON.stringify({ shared: { invalid: true } }), "utf8");

    const error = await prepareSecretsRuntimeSnapshot({
      config,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(listSecretResolutionErrorOwners(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "web-search:gemini",
          reason: "resolved secret value was invalid",
          degradationState: "stale",
          failureMatched: true,
        }),
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "web-fetch:firecrawl",
          reason: "resolved secret value was invalid",
          degradationState: "stale",
          failureMatched: true,
        }),
      ]),
    );
  });

  it("keeps TTS SecretRefs that resolve to non-strings fail-closed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-tts-secretref-object-");
    const secretsPath = path.join(root, "secrets.json");
    await fs.writeFile(
      secretsPath,
      JSON.stringify(
        {
          providers: {
            elevenlabs: {
              apiKey: { value: "not-a-string" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.chmod(secretsPath, 0o600);
    const ref = {
      source: "file" as const,
      provider: "ttsfile",
      id: "/providers/elevenlabs/apiKey",
    };
    const config = asConfig({
      secrets: {
        providers: {
          ttsfile: {
            source: "file",
            path: secretsPath,
            mode: "json",
          },
        },
      },
      messages: {
        tts: { providers: { elevenlabs: { apiKey: ref } } },
      },
    });
    const authAgentDir = "/tmp/invalid-value-auth-co-owner";
    const authProfileId = "openai:invalid-value";
    const authOwnerId = resolveAuthProfileSecretOwnerId({
      agentDir: authAgentDir,
      profileId: authProfileId,
    });
    const active = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    active.sourceConfig = config;
    active.config = config;
    active.authStores = [
      {
        agentDir: authAgentDir,
        store: {
          version: 1,
          profiles: {
            [authProfileId]: {
              type: "api_key",
              provider: "openai",
              key: "dummy",
              keyRef: ref,
            },
          },
        },
      },
    ];
    active.secretOwners = [
      {
        ownerKind: "account",
        ownerId: authOwnerId,
        refKeys: ["file:ttsfile:/providers/elevenlabs/apiKey"],
      },
    ];
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const error = await prepareSecretsRuntimeSnapshot({
      config,
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      "messages.tts.providers.elevenlabs.apiKey resolved to a non-string or empty value.",
    );
    expect(listSecretResolutionErrorOwners(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "tts",
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
          reason: "resolved secret value was invalid",
          degradationState: "cold",
          failureMatched: true,
        }),
        expect.objectContaining({
          ownerKind: "account",
          ownerId: authOwnerId,
          reason: "resolved secret value was invalid",
          source: "auth-store",
          failureMatched: true,
        }),
      ]),
    );
  });

  it("reports every cold-start owner sharing an invalid resolved value", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-shared-invalid-secretref-");
    const secretsPath = path.join(root, "secrets.json");
    await fs.writeFile(secretsPath, JSON.stringify({ shared: { invalid: true } }), "utf8");
    await fs.chmod(secretsPath, 0o600);
    const sharedRef = { source: "file" as const, provider: "shared", id: "/shared" };
    const error = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            shared: { source: "file", path: secretsPath, mode: "json" },
          },
        },
        models: {
          providers: {
            example: {
              apiKey: sharedRef,
              baseUrl: "https://example.invalid/v1",
              models: [],
            },
          },
        },
        messages: {
          tts: { providers: { elevenlabs: { apiKey: sharedRef } } },
        },
        skills: {
          entries: {
            healthy: {
              apiKey: { source: "env", provider: "default", id: "HEALTHY_SKILL_KEY" },
            },
          },
        },
      }),
      env: { HEALTHY_SKILL_KEY: "healthy-skill-key" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    const owners = listSecretResolutionErrorOwners(error);
    expect(owners).toHaveLength(2);
    expect(owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: "provider",
          ownerId: "example",
          reason: "resolved secret value was invalid",
          failureMatched: true,
        }),
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "tts",
          reason: "resolved secret value was invalid",
          failureMatched: true,
        }),
      ]),
    );
    expect(owners).not.toContainEqual(expect.objectContaining({ ownerId: "skill:healthy" }));
  });

  it("still fails required gateway auth SecretRefs when env is missing", async () => {
    const error = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    }).catch((failure: unknown) => failure);

    expect(String(error)).toContain(
      'Environment variable "GATEWAY_TOKEN_REF" is missing or empty.',
    );
    expect(listSecretResolutionErrorOwners(error)).toEqual([
      expect.objectContaining({
        ownerKind: "gateway",
        ownerId: "ingress-auth",
        degradationState: "cold",
        failureMatched: true,
      }),
    ]);
  });
});
