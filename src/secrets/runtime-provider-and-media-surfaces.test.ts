/** Tests provider and media-model SecretRef handling in runtime snapshots. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

function createOpenAiFileModelsConfig(): NonNullable<OpenClawConfig["models"]> {
  return {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { source: "file", provider: "default", id: "/providers/openai/apiKey" },
        models: [],
      },
    },
  };
}

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

function envTokenRef(id: string) {
  return { source: "env" as const, provider: "default" as const, id };
}

async function prepareMediaModelAuthSnapshot(params: {
  provider: string;
  tokenRef: ReturnType<typeof envTokenRef>;
  model?: string;
  capabilities?: string[];
  audioEnabled?: boolean;
}) {
  return await prepareSecretsRuntimeSnapshot({
    config: asConfig({
      tools: {
        media: {
          models: [
            {
              provider: params.provider,
              ...(params.model ? { model: params.model } : {}),
              ...(params.capabilities ? { capabilities: params.capabilities } : {}),
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: params.tokenRef,
                },
              },
            },
          ],
          audio: {
            enabled: params.audioEnabled ?? false,
          },
        },
      },
    }),
    env: {},
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
  });
}

describe("secrets runtime provider and media surfaces", () => {
  it("resolves talk realtime provider api key refs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        talk: {
          realtime: {
            provider: "openai",
            providers: {
              openai: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "OPENAI_REALTIME_API_KEY",
                },
                model: "gpt-realtime-2",
              },
            },
          },
        },
      }),
      env: {
        OPENAI_REALTIME_API_KEY: "sk-realtime-test",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.talk?.realtime?.providers?.openai?.apiKey).toBe("sk-realtime-test");
    expect(snapshot.config.talk?.realtime?.providers?.openai?.model).toBe("gpt-realtime-2");
  });

  it("resolves file refs via configured file provider", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-file-provider-"));
    const secretsPath = path.join(root, "secrets.json");
    try {
      await fs.writeFile(
        secretsPath,
        JSON.stringify(
          {
            providers: {
              openai: {
                apiKey: "sk-from-file-provider",
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.chmod(secretsPath, 0o600);

      const config = asConfig({
        secrets: {
          providers: {
            default: {
              source: "file",
              path: secretsPath,
              mode: "json",
            },
          },
          defaults: {
            file: "default",
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "file", provider: "default", id: "/providers/openai/apiKey" },
              models: [],
            },
          },
        },
      });

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config,
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });

      expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-from-file-provider");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes provider auth without resolving or republishing gateway state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = autoCleanupTempDirs.make("openclaw-provider-auth-refresh-");
    const secretsPath = path.join(root, "secrets.json");
    const writeSecrets = async (gatewayToken: string | undefined, modelKey: string) => {
      await fs.writeFile(
        secretsPath,
        JSON.stringify({ ...(gatewayToken ? { gatewayToken } : {}), modelKey }, null, 2),
        "utf8",
      );
      await fs.chmod(secretsPath, 0o600);
    };
    try {
      const config = asConfig({
        secrets: {
          providers: {
            default: { source: "file", path: secretsPath, mode: "json" },
          },
          defaults: { file: "default" },
        },
        gateway: {
          auth: {
            mode: "token",
            token: { source: "file", provider: "default", id: "/gatewayToken" },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "file", provider: "default", id: "/modelKey" },
              models: [],
            },
          },
        },
      });
      await writeSecrets("gateway-old", "model-old");
      const initial = await prepareSecretsRuntimeSnapshot({
        config,
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });
      const {
        activateSecretsRuntimeSnapshot,
        getActiveSecretsRuntimeSnapshot,
        refreshActiveProviderAuthRuntimeSnapshot,
      } = await import("./runtime.js");
      const { getRuntimeConfigSourceSnapshot, getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
        await import("../config/runtime-snapshot.js");
      activateSecretsRuntimeSnapshot(initial);
      const runtimeSourceConfig: OpenClawConfig = {
        ...initial.sourceConfig,
        logging: { level: "debug" },
      };
      setRuntimeConfigSnapshot(
        {
          ...initial.config,
          auth: { order: { openai: ["runtime-only-profile"] } },
          gateway: {
            ...initial.config.gateway,
            controlUi: { allowedOrigins: ["https://runtime-only.example"] },
          },
          models: {
            ...initial.config.models,
            pricing: { enabled: true },
          },
        },
        runtimeSourceConfig,
      );

      await writeSecrets(undefined, "model-new");
      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);

      const active = getActiveSecretsRuntimeSnapshot();
      expect(active?.config.gateway?.auth?.token).toBe("gateway-old");
      expect(active?.config.gateway?.controlUi?.allowedOrigins).toEqual([
        "https://runtime-only.example",
      ]);
      expect(active?.config.auth?.order?.openai).toEqual(["runtime-only-profile"]);
      expect(active?.config.models?.pricing?.enabled).toBe(true);
      expect(active?.config.models?.providers?.openai?.apiKey).toBe("model-new");
      expect(getRuntimeConfigSnapshot()).toEqual(active?.config);
      expect(getRuntimeConfigSourceSnapshot()).toEqual(runtimeSourceConfig);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("patches env shorthand model refs into the pinned runtime config", async () => {
    const config = asConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "$OPENAI_API_KEY",
            models: [],
          },
        },
      },
    });
    const initial = await prepareSecretsRuntimeSnapshot({
      config,
      env: { OPENAI_API_KEY: "sk-env-current" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    const {
      activateSecretsRuntimeSnapshot,
      getActiveSecretsRuntimeSnapshot,
      refreshActiveProviderAuthRuntimeSnapshot,
    } = await import("./runtime.js");
    const { setRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
    activateSecretsRuntimeSnapshot(initial);
    const openaiProvider = initial.config.models?.providers?.openai;
    if (!openaiProvider) {
      throw new Error("expected resolved OpenAI provider");
    }
    setRuntimeConfigSnapshot(
      {
        ...initial.config,
        models: {
          ...initial.config.models,
          providers: {
            ...initial.config.models?.providers,
            openai: {
              ...openaiProvider,
              apiKey: "sk-stale-pinned",
            },
          },
        },
      },
      initial.sourceConfig,
    );

    await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);

    expect(getActiveSecretsRuntimeSnapshot()?.config.models?.providers?.openai?.apiKey).toBe(
      "sk-env-current",
    );
  });

  it("retries provider auth publication after a queued runtime config mutation", async () => {
    const initialConfig = asConfig({ gateway: { port: 19_040 } });
    const initial = await prepareSecretsRuntimeSnapshot({
      config: initialConfig,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    const {
      activateSecretsRuntimeSnapshot,
      getActiveSecretsRuntimeSnapshot,
      refreshActiveProviderAuthRuntimeSnapshot,
    } = await import("./runtime.js");
    const { registerProviderAuthRuntimeSnapshotActivationOwner } =
      await import("./runtime-provider-auth-activation.js");
    const { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../config/runtime-snapshot.js");
    activateSecretsRuntimeSnapshot(initial);

    let releaseFirstActivation!: () => void;
    const firstActivationBlocked = new Promise<void>((resolve) => {
      releaseFirstActivation = resolve;
    });
    let reportFirstActivationQueued!: () => void;
    const firstActivationQueued = new Promise<void>((resolve) => {
      reportFirstActivationQueued = resolve;
    });
    let activationCalls = 0;
    registerProviderAuthRuntimeSnapshotActivationOwner({
      runExclusive: async (operation) => {
        activationCalls += 1;
        if (activationCalls === 1) {
          reportFirstActivationQueued();
          await firstActivationBlocked;
        }
        return await operation();
      },
      isCurrent: () => true,
      assertValid: () => undefined,
      publish: async () => undefined,
      onError: (error) => {
        throw error;
      },
    });

    const refresh = refreshActiveProviderAuthRuntimeSnapshot();
    await firstActivationQueued;
    const concurrentConfig = asConfig({
      ...initial.config,
      logging: { level: "debug" },
    });
    setRuntimeConfigSnapshot(concurrentConfig, initial.sourceConfig);
    releaseFirstActivation();

    await expect(refresh).resolves.toBe(true);
    expect(activationCalls).toBe(2);
    expect(getActiveSecretsRuntimeSnapshot()?.config.logging?.level).toBe("debug");
    expect(getRuntimeConfigSnapshot()?.logging?.level).toBe("debug");
  });

  it("fails when file provider payload is not a JSON object", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-file-provider-bad-"));
    const secretsPath = path.join(root, "secrets.json");
    try {
      await fs.writeFile(secretsPath, JSON.stringify(["not-an-object"]), "utf8");
      await fs.chmod(secretsPath, 0o600);

      await expect(
        prepareSecretsRuntimeSnapshot({
          config: asConfig({
            secrets: {
              providers: {
                default: {
                  source: "file",
                  path: secretsPath,
                  mode: "json",
                },
              },
            },
            models: {
              ...createOpenAiFileModelsConfig(),
            },
          }),
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadAuthStore: () => ({ version: 1, profiles: {} }),
        }),
      ).rejects.toThrow("payload is not a JSON object");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves shared media model request refs when capability blocks are omitted", async () => {
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
                  auth: {
                    mode: "authorization-bearer",
                    token: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_AUDIO_TOKEN",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      env: {
        MEDIA_SHARED_AUDIO_TOKEN: "shared-audio-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "shared-audio-token",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats shared media model request refs as inactive when their capabilities are disabled", async () => {
    const sharedTokenRef = envTokenRef("MEDIA_DISABLED_AUDIO_TOKEN");
    const snapshot = await prepareMediaModelAuthSnapshot({
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      tokenRef: sharedTokenRef,
      capabilities: ["audio"],
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: sharedTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("resolves shared media model request refs from inferred provider capabilities", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram Plugin",
      source: "test",
      provider: {
        id: "deepgram",
        capabilities: ["audio"],
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "deepgram",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_INFERRED_AUDIO_TOKEN",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      env: {
        MEDIA_INFERRED_AUDIO_TOKEN: "inferred-audio-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "inferred-audio-token",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats shared media model request refs as inactive when inferred capabilities are disabled", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram Plugin",
      source: "test",
      provider: {
        id: "deepgram",
        capabilities: ["audio"],
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const inferredTokenRef = envTokenRef("MEDIA_INFERRED_DISABLED_AUDIO_TOKEN");
    const snapshot = await prepareMediaModelAuthSnapshot({
      provider: "deepgram",
      tokenRef: inferredTokenRef,
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: inferredTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats section media model request refs as inactive when model capabilities exclude the section", async () => {
    const sectionTokenRef = {
      source: "env" as const,
      provider: "default" as const,
      id: "MEDIA_AUDIO_SECTION_FILTERED_TOKEN",
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            audio: {
              enabled: true,
              models: [
                {
                  provider: "openai",
                  capabilities: ["video"],
                  request: {
                    auth: {
                      mode: "authorization-bearer",
                      token: sectionTokenRef,
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.audio?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: sectionTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.audio.models.0.request.auth.token",
    );
  });

  it("isolates a broken media request ref to its exact model owner", async () => {
    const missingRef = envTokenRef("MISSING_MEDIA_MODEL_VALUE");
    const healthyRef = envTokenRef("HEALTHY_MEDIA_MODEL_VALUE");
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "openai",
                capabilities: ["audio"],
                request: { auth: { mode: "authorization-bearer", token: missingRef } },
              },
              {
                provider: "deepgram",
                capabilities: ["audio"],
                request: { auth: { mode: "authorization-bearer", token: healthyRef } },
              },
            ],
            audio: { enabled: true },
          },
        },
      }),
      env: { HEALTHY_MEDIA_MODEL_VALUE: "test-token" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
      allowUnavailableSecretOwners: true,
    });

    expect(snapshot.config.tools?.media?.models?.[1]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "test-token",
    });
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "media-model:shared:0",
        state: "unavailable",
        paths: ["tools.media.models.0.request.auth.token"],
      },
    ]);
  });

  it("treats defaults memorySearch ref as inactive when all enabled agents disable memorySearch", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "DEFAULT_MEMORY_REMOTE_API_KEY",
                },
              },
            },
          },
          list: [
            {
              enabled: true,
              memorySearch: {
                enabled: false,
              },
            },
          ],
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "DEFAULT_MEMORY_REMOTE_API_KEY",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "agents.defaults.memorySearch.remote.apiKey",
    );
  });

  it("isolates an inherited memory ref to its exact agent owner", async () => {
    const missingRef = envTokenRef("MISSING_TEST_VALUE");
    const healthyValue = "test-token-placeholder";
    const healthyRef = envTokenRef("HEALTHY_TEST_VALUE");
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: missingRef,
                headers: { "X-Memory-Value": missingRef },
              },
            },
          },
          list: [
            { id: "cold", default: true },
            {
              id: "healthy",
              memorySearch: {
                remote: { apiKey: healthyRef, headers: { "X-Memory-Value": healthyRef } },
              },
            },
          ],
        },
      }),
      env: { HEALTHY_TEST_VALUE: healthyValue },
      agentDirs: ["/tmp/openclaw-agent-cold", "/tmp/openclaw-agent-healthy"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
      allowUnavailableSecretOwners: true,
    });

    expect(snapshot.config.agents?.list?.[1]?.memorySearch?.remote?.apiKey).toBe(healthyValue);
    expect(snapshot.config.agents?.list?.[1]?.memorySearch?.remote?.headers).toEqual({
      "X-Memory-Value": healthyValue,
    });
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "memory-provider:cold",
        state: "unavailable",
        paths: [
          "agents.defaults.memorySearch.remote.apiKey",
          "agents.defaults.memorySearch.remote.headers.X-Memory-Value",
        ],
      },
    ]);
  });
});
