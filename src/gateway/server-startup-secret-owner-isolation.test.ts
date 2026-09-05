/** Real Gateway startup coverage for SecretRef owner isolation boundaries. */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeAuthProfileStoreSnapshotCore } from "../agents/auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { tryReadSecretFileSync } from "../infra/secret-file.js";
import { selectAgentSystemEvents } from "../infra/system-event-ownership.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import {
  listActiveDegradedSecretOwners,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { deleteTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import {
  connectWebchatClient,
  getGatewayTestPort,
  installGatewayTestHooks,
  rpcReq,
  setTestPluginRegistry,
  startTestGatewayServer,
  testState,
} from "./test-helpers.js";
import "./server-startup-secret-diagnostics.test-support.js";
import "./server-startup-secret-surfaces.test-support.js";

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
    resetSystemEventsForTest();
  });

  it("routes secrets reload state events to the configured system agent", async () => {
    await withEnvAsync({ SYSTEM_OWNER_SECRET: "available" }, async () => {
      await writeConfig({
        ...baseConfig(),
        agents: {
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { main: { default: true }, ops: {} },
        },
        session: { scope: "global" },
        secrets: { providers: { default: { source: "env" } } },
        tts: {
          providers: {
            elevenlabs: {
              apiKey: { source: "env", provider: "default", id: "SYSTEM_OWNER_SECRET" },
            },
          },
        },
      });

      const port = await getGatewayTestPort();
      server = await startTestGatewayServer(port, { auth: { mode: "none" } });
      const ws = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      try {
        deleteTestEnvValue("SYSTEM_OWNER_SECRET");
        const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {});

        expect(reload.ok, JSON.stringify(reload)).toBe(true);
        expect(reload.payload?.warningCount).toBeGreaterThan(0);
        expect(peekSystemEvents("global")).toEqual([
          expect.stringContaining("[SECRETS_RELOADER_DEGRADED]"),
        ]);
        const events = peekSystemEventEntries("global");
        expect(selectAgentSystemEvents(events, "ops")).toHaveLength(1);
        expect(selectAgentSystemEvents(events, "main")).toEqual([]);
      } finally {
        ws.close();
      }
    });
  });

  it("recovers only a repaired credential-file account through secrets.reload without restarting sibling accounts", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        const credentialPath = path.join(tempDirs.make("openclaw-gateway-credential-"), "token");
        const credentialConfigPath = "channels.telegram.accounts.broken.tokenFile";
        const repairedToken = "repaired-test-token-never-public";
        type TestAccount = {
          accountId: string;
          token?: string;
          credentialDiagnostics?: Array<{
            code: "CREDENTIAL_FILE_UNAVAILABLE";
            path: string;
            reason: string;
          }>;
        };
        const accountStarted = new Map<string, () => void>();
        const startAccount = vi.fn(
          async ({ accountId, abortSignal }: ChannelGatewayContext<TestAccount>) =>
            await new Promise<void>((resolve) => {
              abortSignal.addEventListener("abort", () => resolve(), { once: true });
              accountStarted.get(accountId)?.();
            }),
        );
        const plugin: ChannelPlugin<TestAccount> = {
          ...createChannelTestPluginBase({ id: "telegram" }),
          config: {
            listAccountIds: (config) => Object.keys(config.channels?.telegram?.accounts ?? {}),
            resolveAccount: (config, accountId) => {
              if (!accountId) {
                throw new Error("Missing Telegram test account id");
              }
              const configured = config.channels?.telegram?.accounts?.[accountId];
              if (!configured) {
                throw new Error(`Missing Telegram test account ${accountId}`);
              }
              const credential = configured.tokenFile
                ? tryReadSecretFileSync(
                    configured.tokenFile,
                    "Telegram bot token",
                    {},
                    {
                      configPath: credentialConfigPath,
                    },
                  )
                : { status: "available" as const, value: configured.botToken };
              return {
                accountId,
                ...(credential.status === "configured_unavailable"
                  ? { credentialDiagnostics: [credential.diagnostic] }
                  : { token: typeof credential.value === "string" ? credential.value : undefined }),
              };
            },
          },
          gateway: { startAccount },
        };
        setTestPluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
        );
        await writeConfig({
          ...baseConfig(),
          gateway: { ...baseConfig().gateway, reload: { mode: "off" } },
          channels: {
            telegram: {
              enabled: true,
              healthMonitor: { enabled: false },
              accounts: {
                broken: { tokenFile: credentialPath },
                healthy: { botToken: "healthy-test-token" },
                stopped: { botToken: "stopped-test-token" },
              },
            },
          },
        });
        const configPath = process.env.OPENCLAW_CONFIG_PATH;
        if (!configPath) {
          throw new Error("Gateway test did not configure a config file path");
        }
        const originalConfig = readFileSync(configPath);
        const port = await getGatewayTestPort();
        server = await startTestGatewayServer(port, { auth: { mode: "none" } });
        const ws = await connectWebchatClient({ port, scopes: ["operator.admin"] });
        try {
          const brokenStart = await rpcReq(ws, "channels.start", {
            channel: "telegram",
            accountId: "broken",
          });
          expect(brokenStart.ok).toBe(false);
          for (const accountId of ["healthy", "stopped"]) {
            const pluginStarted = createDeferred();
            accountStarted.set(accountId, pluginStarted.resolve);
            const started = await rpcReq<{ accountId: string; started: boolean }>(
              ws,
              "channels.start",
              { channel: "telegram", accountId },
            );
            expect(started.ok, JSON.stringify(started)).toBe(true);
            expect(started.payload).toMatchObject({ accountId, started: true });
            // The RPC acknowledges handoff; traced startup invokes the plugin on a later turn.
            await pluginStarted.promise;
          }
          expect(startAccount).toHaveBeenCalledTimes(2);
          expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual([
            "healthy",
            "stopped",
          ]);
          const healthyLifetime = startAccount.mock.calls[0]?.[0].abortSignal;
          const stoppedLifetime = startAccount.mock.calls[1]?.[0].abortSignal;
          expect(healthyLifetime?.aborted).toBe(false);
          expect(stoppedLifetime?.aborted).toBe(false);

          const before = await rpcReq<{
            channelAccounts: Record<string, ChannelAccountSnapshot[]>;
          }>(ws, "channels.status", { probe: false });
          expect(before.ok, JSON.stringify(before)).toBe(true);
          const initialAccounts = before.payload?.channelAccounts.telegram ?? [];
          expect(initialAccounts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ accountId: "broken", configured: true, running: false }),
              expect.objectContaining({ accountId: "healthy", running: true }),
              expect.objectContaining({ accountId: "stopped", running: true }),
            ]),
          );
          expect(listActiveDegradedSecretOwners()).toContainEqual(
            expect.objectContaining({
              ownerId: "telegram:broken",
              paths: [credentialConfigPath],
              reason: "credential file is unavailable",
            }),
          );
          expect(brokenStart.error).toMatchObject({ code: "UNAVAILABLE" });
          const publicDiagnostics = JSON.stringify({
            error: brokenStart.error,
            accounts: initialAccounts,
          });
          expect(publicDiagnostics).not.toContain(credentialPath);
          expect(publicDiagnostics).not.toContain(repairedToken);

          const stopped = await rpcReq<{ accountId: string; stopped: boolean }>(
            ws,
            "channels.stop",
            {
              channel: "telegram",
              accountId: "stopped",
            },
          );
          expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
          expect(stopped.payload).toMatchObject({ accountId: "stopped", stopped: true });
          expect(stoppedLifetime?.aborted).toBe(true);
          expect(healthyLifetime?.aborted).toBe(false);

          writeFileSync(credentialPath, repairedToken, { mode: 0o600 });
          expect(readFileSync(configPath)).toEqual(originalConfig);

          const repairedStarted = createDeferred();
          accountStarted.set("broken", repairedStarted.resolve);
          const reload = await rpcReq<{ warningCount: number }>(ws, "secrets.reload", {});
          expect(reload.ok, JSON.stringify(reload)).toBe(true);
          expect(reload.payload).toMatchObject({ warningCount: 0 });
          await repairedStarted.promise;
          expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual([
            "healthy",
            "stopped",
            "broken",
          ]);
          expect(startAccount.mock.calls[2]?.[0].account.token).toBe(repairedToken);
          expect(healthyLifetime?.aborted).toBe(false);
          expect(stoppedLifetime?.aborted).toBe(true);
          expect(listActiveDegradedSecretOwners()).not.toContainEqual(
            expect.objectContaining({ ownerId: "telegram:broken" }),
          );

          const after = await rpcReq<{ channelAccounts: Record<string, ChannelAccountSnapshot[]> }>(
            ws,
            "channels.status",
            { probe: false },
          );
          expect(after.ok, JSON.stringify(after)).toBe(true);
          expect(after.payload?.channelAccounts.telegram).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ accountId: "broken", running: true }),
              expect.objectContaining({ accountId: "healthy", running: true }),
              expect.objectContaining({ accountId: "stopped", running: false }),
            ]),
          );
          expect(JSON.stringify(after.payload)).not.toContain(repairedToken);
          expect(JSON.stringify(after.payload)).not.toContain(credentialPath);
          expect(readFileSync(configPath)).toEqual(originalConfig);
        } finally {
          ws.close();
        }
      },
    );
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
        const store = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
        if (!store || !active) {
          throw new Error("Expected activated Gateway auth profile snapshot");
        }
        const request = vi.fn();
        await expect(
          (async () => {
            const auth = await resolveApiKeyForProviderCore({
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
