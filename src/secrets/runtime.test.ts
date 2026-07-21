/** Tests runtime SecretRef resolution across core config and auth-profile surfaces. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot,
} from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const BUNDLED_CODEX_PLUGIN_ORIGINS = new Map([["codex", "bundled" as const]]);
const BUNDLED_WEBHOOKS_PLUGIN_ORIGINS = new Map([["webhooks", "bundled" as const]]);
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const CODEX_APP_SERVER_TOKEN_REF = {
  source: "env",
  provider: "default",
  id: "CODEX_APP_SERVER_TOKEN",
} as const;

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  clearSecretsRuntimeSnapshot();
});

const TTS_REF = {
  source: "env",
  provider: "default",
  id: "ELEVENLABS_API_KEY",
} as const;

function expectWarning(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
  expected: { code: string; path: string },
): void {
  const warning = snapshot.warnings.find(
    (entry) => entry.code === expected.code && entry.path === expected.path,
  );
  if (!warning) {
    throw new Error(`Expected warning ${expected.code} ${expected.path}`);
  }
}

describe("secrets runtime snapshot", () => {
  it("refreshes healthy owners while an unchanged failed owner keeps last-known-good", async () => {
    const ref = (id: string) => ({ source: "env" as const, provider: "default", id });
    const config = (firstId: string) =>
      asConfig({
        models: {
          providers: {
            first: {
              apiKey: ref(firstId),
              baseUrl: "https://first.example.invalid/v1",
              models: [],
            },
            second: {
              apiKey: ref("SECOND_KEY"),
              baseUrl: "https://second.example.invalid/v1",
              models: [],
            },
          },
        },
      });
    const active = await prepareSecretsRuntimeSnapshot({
      config: config("FIRST_KEY"),
      env: { FIRST_KEY: "first-old", SECOND_KEY: "second-old" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const candidate = await prepareSecretsRuntimeSnapshot({
      config: config("FIRST_KEY"),
      env: { SECOND_KEY: "second-new" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(candidate.config.models?.providers?.first?.apiKey).toBe("first-old");
    expect(candidate.config.models?.providers?.second?.apiKey).toBe("second-new");
    expect(candidate.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "first", degradationState: "stale" },
    ]);
    activateSecretsRuntimeSnapshotState({
      snapshot: candidate,
      refreshContext: null,
      refreshHandler: null,
    });
    expect(() => assertSecretOwnerAvailable("provider", "first")).not.toThrow();
  });

  it("keeps last-known-good across equivalent SecretRef encodings", async () => {
    const canonicalRef = {
      source: "env" as const,
      provider: "default",
      id: "PROVIDER_KEY",
    };
    const config = (apiKey: typeof canonicalRef | string) =>
      asConfig({
        models: {
          providers: {
            first: {
              apiKey,
              baseUrl: "https://first.example.invalid/v1",
              models: [],
            },
          },
        },
      });
    const active = await prepareSecretsRuntimeSnapshot({
      config: config(canonicalRef),
      env: { PROVIDER_KEY: "last-known-good" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const candidate = await prepareSecretsRuntimeSnapshot({
      config: config("$PROVIDER_KEY"),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(candidate.config.models?.providers?.first?.apiKey).toBe("last-known-good");
    expect(candidate.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "first", degradationState: "stale" },
    ]);
  });

  it("makes a changed unresolved owner cold while healthy siblings refresh", async () => {
    const ref = (id: string) => ({ source: "env" as const, provider: "default", id });
    const config = (firstId: string) =>
      asConfig({
        models: {
          providers: {
            first: {
              apiKey: ref(firstId),
              baseUrl: "https://first.example.invalid/v1",
              models: [],
            },
            second: {
              apiKey: ref("SECOND_KEY"),
              baseUrl: "https://second.example.invalid/v1",
              models: [],
            },
          },
        },
      });
    const active = await prepareSecretsRuntimeSnapshot({
      config: config("FIRST_KEY"),
      env: { FIRST_KEY: "first-old", SECOND_KEY: "second-old" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const changedRef = ref("FIRST_KEY_CHANGED");
    const candidate = await prepareSecretsRuntimeSnapshot({
      config: config(changedRef.id),
      env: { SECOND_KEY: "second-new" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(candidate.config.models?.providers?.first?.apiKey).toEqual(changedRef);
    expect(candidate.config.models?.providers?.second?.apiKey).toBe("second-new");
    expect(candidate.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "first", degradationState: "cold" },
    ]);
    activateSecretsRuntimeSnapshotState({
      snapshot: candidate,
      refreshContext: null,
      refreshHandler: null,
    });
    expect(() => assertSecretOwnerAvailable("provider", "first")).toThrow(
      "configured but unavailable",
    );
  });

  it("does not send a stale provider credential to a changed endpoint", async () => {
    const apiKeyRef = {
      source: "env" as const,
      provider: "default",
      id: "PROVIDER_KEY",
    };
    const config = (baseUrl: string) =>
      asConfig({
        models: {
          providers: {
            first: { apiKey: apiKeyRef, baseUrl, models: [] },
          },
        },
      });
    const active = await prepareSecretsRuntimeSnapshot({
      config: config("https://old.example.invalid/v1"),
      env: { PROVIDER_KEY: "last-known-good" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const candidate = await prepareSecretsRuntimeSnapshot({
      config: config("https://new.example.invalid/v1"),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(candidate.config.models?.providers?.first).toMatchObject({
      apiKey: apiKeyRef,
      baseUrl: "https://new.example.invalid/v1",
    });
    expect(candidate.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "first", degradationState: "cold" },
    ]);
  });

  it("isolates only the skill whose API key cannot resolve", async () => {
    const missingRef = {
      source: "env",
      provider: "default",
      id: "MISSING_SKILL_KEY",
    } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        skills: {
          entries: {
            cold: { apiKey: missingRef },
            healthy: {
              apiKey: { source: "env", provider: "default", id: "HEALTHY_SKILL_KEY" },
            },
          },
        },
      }),
      env: { HEALTHY_SKILL_KEY: "healthy" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.skills?.entries?.cold?.apiKey).toEqual(missingRef);
    expect(snapshot.config.skills?.entries?.healthy?.apiKey).toBe("healthy");
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "skill:cold",
        state: "unavailable",
        paths: ["skills.entries.cold.apiKey"],
      },
    ]);
    expectWarning(snapshot, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "skills.entries.cold.apiKey",
    });
  });

  it("isolates one webhooks route while resolving its sibling snapshot", async () => {
    const missingRef = {
      source: "env",
      provider: "default",
      id: "MISSING_WEBHOOK_SECRET",
    } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        plugins: {
          entries: {
            webhooks: {
              enabled: true,
              config: {
                routes: {
                  healthy: {
                    sessionKey: "agent:main:main",
                    secret: {
                      source: "env",
                      provider: "default",
                      id: "HEALTHY_WEBHOOK_SECRET",
                    },
                  },
                  cold: {
                    sessionKey: "agent:main:main",
                    secret: missingRef,
                  },
                  inlineCold: {
                    sessionKey: "agent:main:main",
                    secret: "${MISSING_INLINE_WEBHOOK_SECRET}",
                  },
                },
              },
            },
          },
        },
      }),
      env: { HEALTHY_WEBHOOK_SECRET: "healthy-secret" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: BUNDLED_WEBHOOKS_PLUGIN_ORIGINS,
    });

    const routes = snapshot.config.plugins?.entries?.webhooks?.config?.routes as Record<
      string,
      { secret?: unknown }
    >;
    expect(routes.healthy?.secret).toBe("healthy-secret");
    expect(routes.cold?.secret).toEqual(missingRef);
    expect(routes.inlineCold?.secret).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_INLINE_WEBHOOK_SECRET",
    });
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "route",
        ownerId: "plugins.entries.webhooks.config.routes.cold.secret",
        state: "unavailable",
        paths: ["plugins.entries.webhooks.config.routes.cold.secret"],
        reason: "secret reference was not found",
      },
      {
        ownerKind: "route",
        ownerId: "plugins.entries.webhooks.config.routes.inlineCold.secret",
        state: "unavailable",
        paths: ["plugins.entries.webhooks.config.routes.inlineCold.secret"],
        reason: "secret reference was not found",
      },
    ]);
  });

  it("registers every resolved value for exact redaction", async () => {
    const secret = "runtime-registration-secret";
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        talk: {
          apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
      }),
      env: { TALK_API_KEY: secret },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(redactSensitiveText(`resolved ${secret}`, { mode: "off" })).toBe("resolved runtim…cret");
  });

  it("registers resolved TTS values for exact redaction", async () => {
    const secret = "test-secret";
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tts: { providers: { elevenlabs: { apiKey: TTS_REF } } },
      }),
      env: { ELEVENLABS_API_KEY: secret },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(redactSensitiveText(`resolved ${secret}`, { mode: "off" })).toBe("resolved ***");
  });

  it("resolves sandbox ssh secret refs for active ssh backends", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "ssh",
              ssh: {
                target: "peter@example.com:22",
                identityData: { source: "env", provider: "default", id: "SSH_IDENTITY_DATA" },
                certificateData: {
                  source: "env",
                  provider: "default",
                  id: "SSH_CERTIFICATE_DATA",
                },
                knownHostsData: {
                  source: "env",
                  provider: "default",
                  id: "SSH_KNOWN_HOSTS_DATA",
                },
              },
            },
          },
        },
      }),
      env: {
        SSH_IDENTITY_DATA: "PRIVATE KEY",
        SSH_CERTIFICATE_DATA: "SSH CERT",
        SSH_KNOWN_HOSTS_DATA: "example.com ssh-ed25519 AAAATEST",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    const ssh = snapshot.config.agents?.defaults?.sandbox?.ssh;
    expect(ssh?.identityData).toBe("PRIVATE KEY");
    expect(ssh?.certificateData).toBe("SSH CERT");
    expect(ssh?.knownHostsData).toBe("example.com ssh-ed25519 AAAATEST");
  });

  it("keeps SSH lifecycle secrets materialized after the agent sandbox is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
              backend: "ssh",
              ssh: { target: "peter@example.com:22" },
            },
          },
          entries: {
            worker: {
              enabled: false,
              sandbox: {
                ssh: {
                  identityData: {
                    source: "env",
                    provider: "default",
                    id: "DISABLED_WORKER_SSH_IDENTITY",
                  },
                },
              },
            },
          },
        },
      }),
      env: { DISABLED_WORKER_SSH_IDENTITY: "DISABLED WORKER PRIVATE KEY" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.entries?.worker?.sandbox?.ssh?.identityData).toBe(
      "DISABLED WORKER PRIVATE KEY",
    );
  });

  it("keeps default SSH lifecycle secrets materialized when every listed agent overrides them", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
              backend: "ssh",
              ssh: {
                target: "peter@example.com:22",
                identityData: {
                  source: "env",
                  provider: "default",
                  id: "DEFAULT_SSH_IDENTITY",
                },
              },
            },
          },
          entries: {
            worker: {
              sandbox: {
                ssh: {
                  identityData: {
                    source: "env",
                    provider: "default",
                    id: "WORKER_SSH_IDENTITY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        DEFAULT_SSH_IDENTITY: "DEFAULT PRIVATE KEY",
        WORKER_SSH_IDENTITY: "WORKER PRIVATE KEY",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toBe(
      "DEFAULT PRIVATE KEY",
    );
    expect(snapshot.config.agents?.entries?.worker?.sandbox?.ssh?.identityData).toBe(
      "WORKER PRIVATE KEY",
    );
  });

  it("isolates only the agent whose inherited sandbox SSH SecretRef is unavailable", async () => {
    const missingRef = {
      source: "env",
      provider: "default",
      id: "MISSING_COLD_SSH_IDENTITY",
    } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "ssh",
              ssh: {
                target: "sandbox@example.com:22",
                identityData: missingRef,
              },
            },
          },
          entries: {
            cold: {},
            healthy: {
              sandbox: {
                ssh: {
                  identityData: {
                    source: "env",
                    provider: "default",
                    id: "HEALTHY_SSH_IDENTITY",
                  },
                },
              },
            },
          },
        },
      }),
      env: { HEALTHY_SSH_IDENTITY: "HEALTHY PRIVATE KEY" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual(missingRef);
    expect(snapshot.config.agents?.entries?.healthy?.sandbox?.ssh?.identityData).toBe(
      "HEALTHY PRIVATE KEY",
    );
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "agent-sandbox:cold",
        state: "unavailable",
        paths: ["agents.defaults.sandbox.ssh.identityData"],
      },
    ]);
    expectWarning(snapshot, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "agents.defaults.sandbox.ssh.identityData",
    });
  });

  it("treats sandbox ssh secret refs as inactive when ssh backend is not selected", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "docker",
              ssh: {
                identityData: { source: "env", provider: "default", id: "SSH_IDENTITY_DATA" },
              },
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual({
      source: "env",
      provider: "default",
      id: "SSH_IDENTITY_DATA",
    });
    expectWarning(snapshot, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "agents.defaults.sandbox.ssh.identityData",
    });
  });

  it("keeps defaults sandbox ssh refs inactive before the first agent exists", async () => {
    const ref = { source: "env" as const, provider: "default", id: "SSH_IDENTITY_DATA" };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          list: [],
          defaults: {
            sandbox: { mode: "all", backend: "ssh", ssh: { identityData: ref } },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual(ref);
  });

  it("resolves active bundled Codex app-server plugin SecretRefs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  transport: "websocket",
                  url: "wss://codex-app-server.example.internal/ws",
                  authToken: CODEX_APP_SERVER_TOKEN_REF,
                  headers: {
                    Authorization: "Bearer literal-token",
                    "x-codex-client-session-token": "${CODEX_CLIENT_SESSION_TOKEN}",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        CODEX_APP_SERVER_TOKEN: "resolved-app-server-token",
        CODEX_CLIENT_SESSION_TOKEN: "resolved-session-token",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.plugins?.entries?.codex?.config).toMatchObject({
      appServer: {
        authToken: "resolved-app-server-token",
        headers: {
          Authorization: "Bearer literal-token",
          "x-codex-client-session-token": "resolved-session-token",
        },
      },
    });
  });

  it("fails active bundled Codex app-server plugin SecretRefs when env is missing", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          plugins: {
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    transport: "websocket",
                    url: "wss://codex-app-server.example.internal/ws",
                    authToken: CODEX_APP_SERVER_TOKEN_REF,
                    headers: {
                      "x-codex-client-session-token": "${CODEX_CLIENT_SESSION_TOKEN}",
                    },
                  },
                },
              },
            },
          },
        }),
        env: {
          CODEX_CLIENT_SESSION_TOKEN: "resolved-session-token",
        },
        includeAuthStoreRefs: false,
        loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "CODEX_APP_SERVER_TOKEN" is missing or empty.');
  });

  it("isolates the TTS owner when its SecretRef is missing during cold startup", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tts: {
          providers: {
            elevenlabs: {
              apiKey: TTS_REF,
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.tts?.providers?.elevenlabs?.apiKey).toEqual(TTS_REF);
    expectWarning(snapshot, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "tts.providers.elevenlabs.apiKey",
    });
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        paths: ["tts.providers.elevenlabs.apiKey"],
        reason: "secret reference was not found",
      },
    ]);
    expect(snapshot.warnings[0]?.message).not.toContain("ELEVENLABS_API_KEY");
  });

  it("isolates the TTS owner when a file value is absent", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-tts-secretref-missing-");
    const secretsPath = path.join(root, "secrets.json");
    await fs.writeFile(secretsPath, JSON.stringify({ providers: {} }, null, 2), "utf8");
    await fs.chmod(secretsPath, 0o600);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            ttsfile: {
              source: "file",
              path: secretsPath,
              mode: "json",
            },
          },
        },
        tts: {
          providers: {
            elevenlabs: {
              apiKey: {
                source: "file",
                provider: "ttsfile",
                id: "/providers/elevenlabs/apiKey",
              },
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.tts?.providers?.elevenlabs?.apiKey).toEqual({
      source: "file",
      provider: "ttsfile",
      id: "/providers/elevenlabs/apiKey",
    });
    expectWarning(snapshot, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "tts.providers.elevenlabs.apiKey",
    });
    expect(snapshot.warnings[0]?.message).toContain("secret reference was not found");
  });

  it("rejects owner isolation after provider policy failures", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          secrets: {
            providers: {
              default: {
                source: "env",
                allowlist: ["OTHER_API_KEY"],
              },
            },
          },
          tts: {
            providers: {
              elevenlabs: {
                apiKey: TTS_REF,
              },
            },
          },
        }),
        env: {
          ELEVENLABS_API_KEY: "test-elevenlabs-api-key",
        },
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow("not allowlisted");
  });

  it("keeps invalid TTS SecretRef ids fail-closed", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          tts: {
            providers: {
              elevenlabs: {
                apiKey: { source: "env", provider: "default", id: "elevenlabs_api_key" },
              },
            },
          },
        }),
        env: {
          elevenlabs_api_key: "test-elevenlabs-api-key",
        },
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow("Env secret reference id must match");
  });

  it("keeps unconfigured SecretRef provider aliases fail-closed", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          tts: {
            providers: {
              elevenlabs: {
                apiKey: { source: "env", provider: "missing", id: "ELEVENLABS_API_KEY" },
              },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Secret provider "missing" is not configured');
  });

  it("isolates an unavailable model provider without applying another credential source", async () => {
    const ref = { source: "env", provider: "default", id: "MISSING_PROVIDER_KEY" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            example: {
              apiKey: ref,
              baseUrl: "https://example.invalid/v1",
              models: [{ id: "example-model", name: "Example" }],
            },
          },
        },
      }),
      env: { EXAMPLE_API_KEY: "placeholder" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.models?.providers?.example?.apiKey).toEqual(ref);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        state: "unavailable",
        paths: ["models.providers.example.apiKey"],
      },
    ]);
  });

  it("isolates cron webhook delivery when its token cannot resolve", async () => {
    const ref = { source: "env", provider: "default", id: "MISSING_WEBHOOK_TOKEN" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        cron: { webhookToken: ref },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.cron?.webhookToken).toEqual(ref);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "cron-webhook",
        state: "unavailable",
        paths: ["cron.webhookToken"],
      },
    ]);
  });

  it("fails when an active exec ref id contains traversal segments", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          talk: {
            apiKey: { source: "exec", provider: "vault", id: "a/../b" },
          },
          secrets: {
            providers: {
              vault: {
                source: "exec",
                command: process.execPath,
              },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow(/must not include "\." or "\.\." path segments/i);
  });
});
