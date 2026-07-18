/** Real Gateway startup coverage for SecretRef owner isolation boundaries. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

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

describe("Gateway startup SecretRef owner isolation", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reaches /readyz with missing TTS and unused model-provider owners", async () => {
    await withEnvAsync(
      {
        MISSING_TTS_KEY: undefined,
        MISSING_UNUSED_PROVIDER_KEY: undefined,
        OPENAI_API_KEY: "placeholder",
      },
      async () => {
        await writeConfig({
          ...baseConfig(),
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_TTS_KEY" },
                },
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
        });

        const port = await getFreePort();
        server = await startGatewayServer(port, { auth: { mode: "none" } });
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({ ready: true });
        expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
          { ownerKind: "provider", ownerId: "openai", state: "unavailable" },
          { ownerKind: "capability", ownerId: "tts", state: "unavailable" },
        ]);
        expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "models.providers.openai.apiKey",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "messages.tts.providers.elevenlabs.apiKey",
            }),
          ]),
        );
      },
    );
  });

  it("reaches /readyz with a cold memory provider and rejects only that owner", async () => {
    await withEnvAsync({ MISSING_MEMORY_KEY: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: { source: "env", provider: "default", id: "MISSING_MEMORY_KEY" },
              },
            },
          },
        },
      });

      const port = await getFreePort();
      server = await startGatewayServer(port, { auth: { mode: "none" } });
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(ready.status).toBe(200);
      const active = getActiveSecretsRuntimeSnapshot();
      expect(active?.degradedOwners).toMatchObject([
        {
          ownerKind: "capability",
          ownerId: "memory-provider:main",
          state: "unavailable",
        },
      ]);
      if (!active) {
        throw new Error("Expected active secrets runtime snapshot");
      }
      let thrown: unknown;
      try {
        resolveMemorySearchConfig(active.config, "main");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "capability",
        ownerId: "memory-provider:main",
      });
    });
  });

  it("reaches /readyz with one cold media model", async () => {
    await withEnvAsync({ MISSING_MEDIA_MODEL_VALUE: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        tools: {
          media: {
            audio: {
              enabled: true,
              models: [
                {
                  provider: "openai",
                  request: {
                    auth: {
                      mode: "authorization-bearer",
                      token: {
                        source: "env",
                        provider: "default",
                        id: "MISSING_MEDIA_MODEL_VALUE",
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const port = await getFreePort();
      server = await startGatewayServer(port, { auth: { mode: "none" } });
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(ready.status).toBe(200);
      expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
        {
          ownerKind: "capability",
          ownerId: "media-model:audio:0",
          state: "unavailable",
        },
      ]);
    });
  });

  it("reaches /readyz with one cold agent sandbox and rejects that runtime", async () => {
    await withEnvAsync({ MISSING_SANDBOX_IDENTITY: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
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
          list: [{ id: "cold" }],
        },
      });

      const port = await getFreePort();
      server = await startGatewayServer(port, { auth: { mode: "none" } });
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(ready.status).toBe(200);
      const active = getActiveSecretsRuntimeSnapshot();
      expect(active?.degradedOwners).toMatchObject([
        {
          ownerKind: "capability",
          ownerId: "agent-sandbox:cold",
          state: "unavailable",
          paths: ["agents.defaults.sandbox.ssh.identityData"],
        },
      ]);
      if (!active) {
        throw new Error("Expected active secrets runtime snapshot");
      }
      await expect(
        resolveSandboxContext({
          config: active.config,
          agentId: "cold",
          sessionKey: "agent:cold:main",
        }),
      ).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "capability",
        ownerId: "agent-sandbox:cold",
      });
    });
  });

  it("isolates TTS during a successful Gateway-auth SecretRef preflight", async () => {
    await withEnvAsync(
      {
        GATEWAY_TOKEN_REF: "placeholder",
        MISSING_TTS_KEY: undefined,
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
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_TTS_KEY" },
                },
              },
            },
          },
        });
        testState.gatewayAuth = undefined;

        const port = await getFreePort();
        server = await startGatewayServer(port);
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

        expect(ready.status).toBe(200);
        expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe("placeholder");
        expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
          { ownerKind: "capability", ownerId: "tts", state: "unavailable" },
        ]);
      },
    );
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

        const port = await getFreePort();
        server = await startGatewayServer(port, { auth: { mode: "none" } });
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

      await expect(startGatewayServer(await getFreePort())).rejects.toThrow(
        /Startup failed: required secrets are unavailable/,
      );
    });
  });

  it("reaches /readyz with cron webhook delivery isolated", async () => {
    await withEnvAsync({ MISSING_WEBHOOK_TOKEN: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        cron: {
          webhookToken: {
            source: "env",
            provider: "default",
            id: "MISSING_WEBHOOK_TOKEN",
          },
        },
      });

      const port = await getFreePort();
      server = await startGatewayServer(port, { auth: { mode: "none" } });
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toMatchObject({ ready: true });
      expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
        { ownerKind: "capability", ownerId: "cron-webhook", state: "unavailable" },
      ]);
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "SECRETS_OWNER_UNAVAILABLE",
            path: "cron.webhookToken",
          }),
        ]),
      );
    });
  });

  it("reaches /readyz with one skill secret isolated", async () => {
    await withEnvAsync({ MISSING_SKILL_KEY: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        skills: {
          entries: {
            cold: {
              apiKey: {
                source: "env",
                provider: "default",
                id: "MISSING_SKILL_KEY",
              },
            },
          },
        },
      });

      const port = await getFreePort();
      server = await startGatewayServer(port, { auth: { mode: "none" } });
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(ready.status).toBe(200);
      expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
        { ownerKind: "capability", ownerId: "skill:cold", state: "unavailable" },
      ]);
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "SECRETS_OWNER_UNAVAILABLE",
            path: "skills.entries.cold.apiKey",
          }),
        ]),
      );
    });
  });
});
