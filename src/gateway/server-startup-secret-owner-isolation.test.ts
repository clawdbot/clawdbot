/** Real Gateway startup coverage for SecretRef owner isolation boundaries. */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
  testState,
} from "./test-helpers.js";
import "./server-startup-secret-diagnostics.test-support.js";
import "./server-startup-secret-surfaces.test-support.js";
import "./server-startup-session-migration.test-support.js";

const { webSearchProviders } = vi.hoisted(() => {
  const credentialPath = "plugins.entries.google.config.webSearch.apiKey";
  return {
    webSearchProviders: [
      {
        pluginId: "google",
        id: "gemini",
        label: "Gemini",
        hint: "Gateway startup owner-isolation provider",
        envVars: ["GEMINI_API_KEY"],
        placeholder: "gemini-...",
        signupUrl: "https://example.com/gemini",
        autoDetectOrder: 20,
        credentialPath,
        inactiveSecretPaths: [credentialPath],
        getCredentialValue: (config: { apiKey?: unknown } | undefined) => config?.apiKey,
        setCredentialValue: (config: { apiKey?: unknown }, value: unknown) => {
          config.apiKey = value;
        },
        getConfiguredCredentialValue: (config: OpenClawConfig | undefined) => {
          const pluginConfig = config?.plugins?.entries?.google?.config;
          return pluginConfig && typeof pluginConfig === "object"
            ? (pluginConfig as { webSearch?: { apiKey?: unknown } }).webSearch?.apiKey
            : undefined;
        },
        setConfiguredCredentialValue: () => {},
        createTool: () => null,
      },
    ],
  };
});

vi.mock("../secrets/runtime-web-tools-manifest.runtime.js", () => ({
  resolveManifestContractPluginIds: ({ contract }: { contract: string }) =>
    contract === "webSearchProviders" ? ["google"] : [],
  resolveManifestContractOwnerPluginId: ({ value }: { value: string }) =>
    value === "gemini" ? "google" : undefined,
}));

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../secrets/runtime-web-tools-public-artifacts.runtime.js", () => ({
  resolveBundledWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../secrets/runtime-web-tools-fallback.runtime.js", () => ({
  runtimeWebToolsFallbackProviders: {
    resolvePluginWebSearchProviders: () => webSearchProviders,
    resolvePluginWebFetchProviders: () => [],
  },
}));

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile(config);
}

function baseConfig(): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
    },
  };
}

async function startVaultAclFixture() {
  const requests: string[] = [];
  const vault = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.statusCode = 403;
    response.end(JSON.stringify({ errors: ["permission denied"] }));
  });
  await new Promise<void>((resolve) => {
    vault.listen(0, "127.0.0.1", resolve);
  });
  const address = vault.address();
  if (!address || typeof address === "string") {
    throw new Error("Vault ACL fixture did not bind to a TCP port");
  }
  return {
    requests,
    vaultAddr: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        vault.close(() => resolve());
      }),
  };
}

describe("Gateway startup SecretRef owner isolation", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setActiveDegradedSecretOwners([]);
  });

  it("reaches /readyz while isolating every optional owner family", async () => {
    await withEnvAsync(
      {
        GATEWAY_TOKEN_REF: "placeholder",
        GEMINI_API_KEY: "test-gemini-api-key",
        HEALTHY_MEMORY_KEY: "healthy-memory-key",
        HEALTHY_SANDBOX_IDENTITY: "healthy-sandbox-identity",
        OPENCLAW_TEST_ACTIVE_WEB_SEARCH_SECRET: undefined,
        MISSING_MEMORY_KEY: undefined,
        MISSING_SANDBOX_IDENTITY: undefined,
        MISSING_SKILL_KEY: undefined,
        MISSING_TTS_KEY: undefined,
        MISSING_UNUSED_PROVIDER_KEY: undefined,
        MISSING_WEBHOOK_TOKEN: undefined,
      },
      async () => {
        await writeConfig({
          ...baseConfig(),
          gateway: {
            mode: "local",
            bind: "loopback",
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
            },
          },
          secrets: { providers: { default: { source: "env" } } },
          tts: {
            providers: {
              elevenlabs: {
                apiKey: { source: "env", provider: "default", id: "MISSING_TTS_KEY" },
              },
            },
          },
          models: {
            providers: {
              openai: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_UNUSED_PROVIDER_KEY",
                },
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
          tools: {
            media: {
              models: [{ provider: "openai", capabilities: ["audio"] }],
              audio: { enabled: true },
            },
            web: { search: { enabled: true, provider: "gemini" } },
          },
          memory: {
            search: {
              remote: {
                apiKey: { source: "env", provider: "default", id: "MISSING_MEMORY_KEY" },
              },
            },
          },
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                backend: "ssh",
                ssh: {
                  target: "sandbox@example.com:22",
                  identityData: {
                    source: "env",
                    provider: "default",
                    id: "MISSING_SANDBOX_IDENTITY",
                  },
                },
              },
            },
            entries: {
              main: {
                default: true,
                sandbox: {
                  ssh: {
                    identityData: {
                      source: "env",
                      provider: "default",
                      id: "HEALTHY_SANDBOX_IDENTITY",
                    },
                  },
                },
              },
              cold: {
                memory: {
                  search: {
                    remote: {
                      apiKey: {
                        source: "env",
                        provider: "default",
                        id: "HEALTHY_MEMORY_KEY",
                      },
                    },
                  },
                },
              },
            },
          },
          cron: {
            webhookToken: {
              source: "env",
              provider: "default",
              id: "MISSING_WEBHOOK_TOKEN",
            },
          },
          skills: {
            entries: {
              cold: {
                apiKey: { source: "env", provider: "default", id: "MISSING_SKILL_KEY" },
              },
            },
          },
          plugins: {
            enabled: true,
            entries: {
              google: {
                enabled: true,
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "OPENCLAW_TEST_ACTIVE_WEB_SEARCH_SECRET",
                    },
                  },
                },
              },
            },
          },
        });
        testState.gatewayAuth = undefined;

        const port = await getGatewayTestPort();
        server = await startTestGatewayServer(port);
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({ ready: true });
        const active = getActiveSecretsRuntimeSnapshot();
        expect(active?.config.gateway?.auth?.token).toBe("placeholder");
        expect(active?.degradedOwners).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              ownerKind: "provider",
              ownerId: "openai",
              state: "unavailable",
            }),
            expect.objectContaining({
              ownerKind: "capability",
              ownerId: "tts",
              state: "unavailable",
            }),
            expect.objectContaining({
              ownerKind: "capability",
              ownerId: "memory-provider:main",
              state: "unavailable",
            }),
            expect.objectContaining({
              ownerKind: "capability",
              ownerId: "agent-sandbox:cold",
              state: "unavailable",
            }),
            expect.objectContaining({
              ownerKind: "capability",
              ownerId: "cron-webhook",
              state: "unavailable",
            }),
            expect.objectContaining({
              ownerKind: "capability",
              ownerId: "skill:cold",
              state: "unavailable",
            }),
            expect.objectContaining({
              ownerKind: "capability",
              ownerId: "web-search:gemini",
              state: "unavailable",
            }),
          ]),
        );
        expect(active?.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "models.providers.openai.apiKey",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "tts.providers.elevenlabs.apiKey",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "memory.search.remote.apiKey",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "agents.defaults.sandbox.ssh.identityData",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "cron.webhookToken",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "skills.entries.cold.apiKey",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "plugins.entries.google.config.webSearch.apiKey",
            }),
          ]),
        );
        if (!active) {
          throw new Error("Expected active secrets runtime snapshot");
        }
        expect(() => resolveMemorySearchConfig(active.config, "main")).toThrow(
          expect.objectContaining({
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerKind: "capability",
            ownerId: "memory-provider:main",
          }),
        );
        await expect(
          resolveSandboxContext({
            config: active.config,
            agentId: "cold",
            sessionKey: "agent:cold:main",
          }),
        ).rejects.toMatchObject({
          code: "sandbox_provisioning",
          backendId: "ssh",
          message: expect.stringContaining("openclaw secrets reload"),
          cause: {
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerKind: "capability",
            ownerId: "agent-sandbox:cold",
          },
        });
      },
    );
  });

  it("fans one Vault auth outage out to standard and web-tool owners", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-gateway-provider-outage-");
    const callLogPath = path.join(root, "calls.log");
    const commandPath = path.join(root, "provider.sh");
    const resolverPath = path.resolve("extensions/vault/vault-secret-ref-resolver.js");
    writeFileSync(
      commandPath,
      `#!/bin/sh\nprintf 'call\\n' >> ${JSON.stringify(callLogPath)}\n` +
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolverPath)}\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    await withEnvAsync({ VAULT_ADDR: "https://vault.example.test" }, async () => {
      await writeConfig({
        ...baseConfig(),
        secrets: {
          providers: {
            vault: { source: "exec", command: commandPath, passEnv: ["PATH", "VAULT_ADDR"] },
          },
        },
        models: {
          providers: {
            openai: {
              apiKey: { source: "exec", provider: "vault", id: "models/openai" },
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
        tts: {
          providers: {
            elevenlabs: {
              apiKey: { source: "exec", provider: "vault", id: "tts/elevenlabs" },
            },
          },
        },
        tools: { web: { search: { provider: "gemini" } } },
        plugins: {
          enabled: true,
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "exec", provider: "vault", id: "web/gemini" },
                },
              },
            },
          },
        },
      });

      const port = await getGatewayTestPort();
      server = await startTestGatewayServer(port, { auth: { mode: "none" } });
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toMatchObject({ ready: true });
      expect(readFileSync(callLogPath, "utf8").trim().split("\n")).toHaveLength(2);
      expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
        {
          ownerKind: "provider",
          ownerId: "openai",
          providerFailures: [{ source: "exec", provider: "vault" }],
        },
        {
          ownerKind: "capability",
          ownerId: "tts",
          providerFailures: [{ source: "exec", provider: "vault" }],
        },
        {
          ownerKind: "capability",
          ownerId: "web-search:gemini",
          providerFailures: [{ source: "exec", provider: "vault" }],
        },
      ]);
    });
  });

  it("keeps Vault path ACL failures scoped when token introspection is denied", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-gateway-vault-acl-");
    const commandPath = path.join(root, "provider.sh");
    const resolverPath = path.resolve("extensions/vault/vault-secret-ref-resolver.js");
    writeFileSync(
      commandPath,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolverPath)}\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    const vault = await startVaultAclFixture();
    try {
      await withEnvAsync(
        { VAULT_ADDR: vault.vaultAddr, VAULT_TOKEN: "not-a-real-auth-header" },
        async () => {
          await writeConfig({
            ...baseConfig(),
            secrets: {
              providers: {
                vault: {
                  source: "exec",
                  command: commandPath,
                  passEnv: ["PATH", "VAULT_ADDR", "VAULT_TOKEN"],
                },
              },
            },
            models: {
              providers: {
                openai: {
                  apiKey: { source: "exec", provider: "vault", id: "models/openai" },
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: { source: "exec", provider: "vault", id: "tts/elevenlabs" },
                },
              },
            },
          });

          const port = await getGatewayTestPort();
          server = await startTestGatewayServer(port, { auth: { mode: "none" } });
          const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

          expect(ready.status).toBe(200);
          await expect(ready.json()).resolves.toMatchObject({ ready: true });
          const snapshot = getActiveSecretsRuntimeSnapshot();
          const degradedOwners = snapshot?.degradedOwners ?? [];
          expect(degradedOwners).toMatchObject([
            { ownerKind: "provider", ownerId: "openai", state: "unavailable" },
            { ownerKind: "capability", ownerId: "tts", state: "unavailable" },
          ]);
          expect(degradedOwners.every((owner) => !owner.providerFailures)).toBe(true);
          expect(snapshot?.warnings).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: "SECRETS_OWNER_UNAVAILABLE",
                path: "models.providers.openai.apiKey",
              }),
              expect.objectContaining({
                code: "SECRETS_OWNER_UNAVAILABLE",
                path: "tts.providers.elevenlabs.apiKey",
              }),
            ]),
          );
          expect(
            vault.requests.filter((url) => url === "/v1/auth/token/lookup-self").length,
          ).toBeGreaterThan(0);
        },
      );
    } finally {
      await vault.close();
    }
  });

  it("starts with a selected provider profile cold and fails its first request before dispatch", async () => {
    await withEnvAsync(
      {
        MISSING_SELECTED_PROFILE_KEY: undefined,
        OPENAI_API_KEY: "unused",
      },
      async () => {
        const profileId = "openai:cold";
        const config: OpenClawConfig = {
          ...baseConfig(),
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4" },
            },
          },
          auth: {
            order: { openai: [profileId] },
          },
        };
        const agentDir = resolveDefaultAgentDir(config);
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "api_key",
                provider: "openai",
                keyRef: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_SELECTED_PROFILE_KEY",
                },
              },
            },
          },
          agentDir,
        );
        await writeConfig(config);

        const port = await getGatewayTestPort();
        server = await startTestGatewayServer(port, { auth: { mode: "none" } });
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(ready.status).toBe(200);

        const ownerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId });
        const active = getActiveSecretsRuntimeSnapshot();
        expect(active?.degradedOwners).toMatchObject([
          { ownerKind: "account", ownerId, state: "unavailable" },
        ]);
        const store = getRuntimeAuthProfileStoreSnapshot(agentDir);
        if (!store || !active) {
          throw new Error("Expected activated Gateway auth profile snapshot");
        }
        const request = vi.fn();
        await expect(
          (async () => {
            const auth = await resolveApiKeyForProvider({
              provider: "openai",
              cfg: active.config,
              store,
              agentDir,
            });
            await request(auth);
          })(),
        ).rejects.toMatchObject({
          code: "SECRET_SURFACE_UNAVAILABLE",
          ownerKind: "account",
          ownerId,
        });
        expect(request).not.toHaveBeenCalled();
      },
    );
  });

  it("still refuses startup when Gateway ingress auth cannot resolve", async () => {
    await withEnvAsync({ MISSING_GATEWAY_TOKEN: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
          },
        },
      });
      testState.gatewayAuth = undefined;

      await expect(startTestGatewayServer(await getGatewayTestPort())).rejects.toThrow(
        /Startup failed: required secrets are unavailable/,
      );
    });
  });
});
