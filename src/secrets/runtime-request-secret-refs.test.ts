import { describe, expect, it } from "vitest";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot request secret refs", () => {
  it("can skip auth-profile SecretRef resolution when includeAuthStoreRefs is false", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_SECRET_${Date.now()}`;
    delete process.env[missingEnvVar];

    const loadAuthStore = () =>
      loadAuthStoreWithProfiles({
        "custom:token": {
          type: "token",
          provider: "custom",
          tokenRef: { source: "env", provider: "default", id: missingEnvVar },
        },
      });

    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({}),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore,
      }),
    ).rejects.toThrow(`Environment variable "${missingEnvVar}" is missing or empty.`);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {},
      includeAuthStoreRefs: false,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore,
    });

    expect(snapshot.authStores).toStrictEqual([]);
  });

  it("resolves model provider request secret refs for headers, auth, and tls material", async () => {
    const config = asConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            request: {
              headers: {
                "X-Tenant": { source: "env", provider: "default", id: "OPENAI_PROVIDER_TENANT" },
              },
              auth: {
                mode: "authorization-bearer",
                token: { source: "env", provider: "default", id: "OPENAI_PROVIDER_TOKEN" },
              },
              proxy: {
                mode: "explicit-proxy",
                url: "http://proxy.example:8080",
                tls: {
                  ca: { source: "env", provider: "default", id: "OPENAI_PROVIDER_PROXY_CA" },
                },
              },
              tls: {
                cert: { source: "env", provider: "default", id: "OPENAI_PROVIDER_CERT" },
                key: { source: "env", provider: "default", id: "OPENAI_PROVIDER_KEY" },
              },
            },
            models: [],
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        OPENAI_PROVIDER_TENANT: "tenant-acme",
        OPENAI_PROVIDER_TOKEN: "sk-provider-runtime", // pragma: allowlist secret
        OPENAI_PROVIDER_PROXY_CA: "proxy-ca",
        OPENAI_PROVIDER_CERT: "client-cert",
        OPENAI_PROVIDER_KEY: "client-key",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.models?.providers?.openai?.request).toEqual({
      headers: {
        "X-Tenant": "tenant-acme",
      },
      auth: {
        mode: "authorization-bearer",
        token: "sk-provider-runtime",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: {
          ca: "proxy-ca",
        },
      },
      tls: {
        cert: "client-cert",
        key: "client-key",
      },
    });
  });

  it("resolves media request secret refs for provider headers, auth, and tls material", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  headers: {
                    "X-Shared-Tenant": {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_TENANT",
                    },
                  },
                  auth: {
                    mode: "header",
                    headerName: "x-shared-key",
                    value: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_MODEL_KEY",
                    },
                  },
                },
              },
            ],
            audio: {
              enabled: true,
              request: {
                headers: {
                  "X-Tenant": { source: "env", provider: "default", id: "MEDIA_AUDIO_TENANT" },
                },
                auth: {
                  mode: "authorization-bearer",
                  token: { source: "env", provider: "default", id: "MEDIA_AUDIO_TOKEN" },
                },
                tls: {
                  cert: { source: "env", provider: "default", id: "MEDIA_AUDIO_CERT" },
                },
              },
              models: [
                {
                  provider: "deepgram",
                  request: {
                    auth: {
                      mode: "header",
                      headerName: "x-api-key",
                      value: { source: "env", provider: "default", id: "MEDIA_AUDIO_MODEL_KEY" },
                    },
                    proxy: {
                      mode: "explicit-proxy",
                      url: "http://proxy.example:8080",
                      tls: {
                        ca: { source: "env", provider: "default", id: "MEDIA_AUDIO_PROXY_CA" },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      env: {
        MEDIA_SHARED_TENANT: "tenant-shared",
        MEDIA_SHARED_MODEL_KEY: "shared-model-key", // pragma: allowlist secret
        MEDIA_AUDIO_TENANT: "tenant-acme",
        MEDIA_AUDIO_TOKEN: "audio-token", // pragma: allowlist secret
        MEDIA_AUDIO_CERT: "client-cert",
        MEDIA_AUDIO_MODEL_KEY: "model-key", // pragma: allowlist secret
        MEDIA_AUDIO_PROXY_CA: "proxy-ca",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.audio?.request?.headers?.["X-Tenant"]).toBe("tenant-acme");
    expect(snapshot.config.tools?.media?.audio?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "audio-token",
    });
    expect(snapshot.config.tools?.media?.audio?.request?.tls).toEqual({
      cert: "client-cert",
    });
    expect(snapshot.config.tools?.media?.models?.[0]?.request).toEqual({
      headers: {
        "X-Shared-Tenant": "tenant-shared",
      },
      auth: {
        mode: "header",
        headerName: "x-shared-key",
        value: "shared-model-key",
      },
    });
    expect(snapshot.config.tools?.media?.audio?.models?.[0]?.request).toEqual({
      auth: {
        mode: "header",
        headerName: "x-api-key",
        value: "model-key",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: {
          ca: "proxy-ca",
        },
      },
    });
  });
});
