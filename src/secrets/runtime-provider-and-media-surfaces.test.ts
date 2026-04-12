import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
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

describe("secrets runtime provider and media surfaces", () => {
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
    const sharedTokenRef = {
      source: "env" as const,
      provider: "default" as const,
      id: "MEDIA_DISABLED_AUDIO_TOKEN",
    };
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
                    token: sharedTokenRef,
                  },
                },
              },
            ],
            audio: {
              enabled: false,
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
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

    const inferredTokenRef = {
      source: "env" as const,
      provider: "default" as const,
      id: "MEDIA_INFERRED_DISABLED_AUDIO_TOKEN",
    };
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
                    token: inferredTokenRef,
                  },
                },
              },
            ],
            audio: {
              enabled: false,
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
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
});
