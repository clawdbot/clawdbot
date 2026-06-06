// Local no-auth runner tests cover custom local providers, auth markers, and
// profile/env isolation for audio and video providers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
} from "./types.js";

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOwningPluginIdsForProvider: () => [],
}));

const AUTH_ENV = {
  LOCAL_AUDIO_API_KEY: undefined,
  REMOTE_AUDIO_API_KEY: undefined,
  OPENCLAW_AGENT_DIR: undefined,
} satisfies Record<string, string | undefined>;

function createAudioProvider(
  id: string,
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model?: string }>,
  extra?: Partial<MediaUnderstandingProvider>,
): MediaUnderstandingProvider {
  return {
    id,
    capabilities: ["audio"],
    transcribeAudio,
    ...extra,
  };
}

function createVideoProvider(
  id: string,
  describeVideo: (req: VideoDescriptionRequest) => Promise<{ text: string; model?: string }>,
  extra?: Partial<MediaUnderstandingProvider>,
): MediaUnderstandingProvider {
  return {
    id,
    capabilities: ["video"],
    describeVideo,
    ...extra,
  };
}

async function withIsolatedAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-audio-auth-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function createAudioCfg(params: {
  provider: string;
  model: string;
  providerConfig?: Record<string, unknown>;
  entry?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    ...(params.providerConfig
      ? {
          models: {
            providers: {
              [params.provider]: params.providerConfig,
            },
          },
        }
      : {}),
    tools: {
      media: {
        audio: {
          enabled: true,
          models: [
            { type: "provider", provider: params.provider, model: params.model, ...params.entry },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function createVideoCfg(params: { provider: string; model: string }): OpenClawConfig {
  return {
    tools: {
      media: {
        video: {
          enabled: true,
          models: [{ type: "provider", provider: params.provider, model: params.model }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("runCapability local no-auth audio providers", () => {
  it("allows a local no-auth audio provider when configured as a local models provider", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture("openclaw-local-audio-configured", async ({ ctx, media, cache }) => {
          const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
            text: `ok:${req.apiKey}`,
            model: req.model,
          }));
          const cfg = createAudioCfg({
            provider: "local-audio",
            model: "whisper-local",
            providerConfig: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:43111/v1",
              models: [{ id: "whisper-local", input: ["audio"] }],
            },
          });

          const result = await runCapability({
            capability: "audio",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              "local-audio": createAudioProvider("local-audio", transcribeAudio),
            }),
          });

          expect(result.decision.outcome).toBe("success");
          expect(result.outputs[0]?.text).toBe(`ok:${CUSTOM_LOCAL_AUTH_MARKER}`);
          expect(transcribeAudio).toHaveBeenCalledTimes(1);
          expect(transcribeAudio.mock.calls[0]?.[0].apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
        });
      });
    });
  });

  it("regression #74644: plugin-only local no-auth audio provider can use no-auth", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture(
          "openclaw-local-audio-plugin-only",
          async ({ ctx, media, cache }) => {
            const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
              text: "plugin local ok",
              model: req.model,
            }));
            const cfg = createAudioCfg({ provider: "local-audio", model: "whisper-local" });

            const result = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              agentDir,
              providerRegistry: buildProviderRegistry({
                "local-audio": createAudioProvider("local-audio", transcribeAudio, {
                  resolveAuth: () => ({
                    kind: "none",
                    source: "local-audio plugin no-auth",
                  }),
                }),
              }),
            });

            if (result.decision.outcome !== "success") {
              throw new Error(
                result.decision.attachments[0]?.attempts[0]?.reason ??
                  `expected success, got ${result.decision.outcome}`,
              );
            }
            expect(result.decision.outcome).toBe("success");
            expect(result.outputs[0]?.text).toBe("plugin local ok");
            expect(transcribeAudio).toHaveBeenCalledTimes(1);
            expect(transcribeAudio.mock.calls[0]?.[0].apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
            expect(transcribeAudio.mock.calls[0]?.[0].auth).toEqual({
              kind: "none",
              source: "local-audio plugin no-auth",
            });
          },
        );
      });
    });
  });

  it("prefers resolver env credentials over plugin-only media no-auth", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync({ ...AUTH_ENV, OPENAI_API_KEY: "env-openai-audio-key" }, async () => {
        await withAudioFixture("openclaw-openai-audio-env-key", async ({ ctx, media, cache }) => {
          const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
            text: `env:${req.apiKey}`,
            model: req.model,
          }));
          const cfg = createAudioCfg({ provider: "openai", model: "whisper-1" });

          const result = await runCapability({
            capability: "audio",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              openai: createAudioProvider("openai", transcribeAudio, {
                resolveAuth: () => ({
                  kind: "none",
                  source: "openai plugin no-auth",
                }),
              }),
            }),
          });

          expect(result.decision.outcome).toBe("success");
          expect(result.outputs[0]?.text).toBe("env:env-openai-audio-key");
          expect(transcribeAudio).toHaveBeenCalledTimes(1);
          expect(transcribeAudio.mock.calls[0]?.[0].apiKey).toBe("env-openai-audio-key");
        });
      });
    });
  });

  it("uses OpenAI API key auth for audio when the default OpenAI profile is OAuth", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync({ ...AUTH_ENV, OPENAI_API_KEY: "env-openai-audio-key" }, async () => {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "oauth",
                provider: "openai",
                access: "oauth-chat-token",
                refresh: "oauth-refresh-token",
                expires: Date.now() + 60_000,
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        await withAudioFixture(
          "openclaw-openai-audio-oauth-env-key",
          async ({ ctx, media, cache }) => {
            const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
              text: `auth:${req.apiKey}`,
              model: req.model,
            }));
            const cfg = createAudioCfg({ provider: "openai", model: "whisper-1" });

            const result = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              agentDir,
              providerRegistry: buildProviderRegistry({
                openai: createAudioProvider("openai", transcribeAudio),
              }),
            });

            expect(result.decision.outcome).toBe("success");
            expect(result.outputs[0]?.text).toBe("auth:env-openai-audio-key");
            expect(transcribeAudio).toHaveBeenCalledTimes(1);
            expect(transcribeAudio.mock.calls[0]?.[0].apiKey).toBe("env-openai-audio-key");
          },
        );
      });
    });
  });

  it("prefers stored auth profile credentials over plugin-only media no-auth", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "local-audio:default": {
                type: "api_key",
                provider: "local-audio",
                key: "stored-local-audio-key",
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        await withAudioFixture(
          "openclaw-local-audio-stored-profile",
          async ({ ctx, media, cache }) => {
            const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
              text: `profile:${req.apiKey}`,
              model: req.model,
            }));
            const cfg = createAudioCfg({ provider: "local-audio", model: "whisper-local" });

            const result = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              agentDir,
              providerRegistry: buildProviderRegistry({
                "local-audio": createAudioProvider("local-audio", transcribeAudio, {
                  resolveAuth: () => ({
                    kind: "none",
                    source: "local-audio plugin no-auth",
                  }),
                }),
              }),
            });

            expect(result.decision.outcome).toBe("success");
            expect(result.outputs[0]?.text).toBe("profile:stored-local-audio-key");
            expect(transcribeAudio).toHaveBeenCalledTimes(1);
            expect(transcribeAudio.mock.calls[0]?.[0].apiKey).toBe("stored-local-audio-key");
          },
        );
      });
    });
  });

  it("still rejects a remote audio provider without credentials", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture("openclaw-remote-audio-no-auth", async ({ ctx, media, cache }) => {
          const transcribeAudio = vi.fn(async () => ({
            text: "should not run",
            model: "remote-whisper",
          }));
          const cfg = createAudioCfg({
            provider: "remote-audio",
            model: "remote-whisper",
            providerConfig: {
              api: "openai-completions",
              baseUrl: "https://example.invalid/v1",
              models: [{ id: "remote-whisper", input: ["audio"] }],
            },
          });

          const result = await runCapability({
            capability: "audio",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              "remote-audio": createAudioProvider("remote-audio", transcribeAudio),
            }),
          });

          expect(result.decision.outcome).toBe("failed");
          expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain(
            'No API key found for provider "remote-audio"',
          );
          expect(transcribeAudio).not.toHaveBeenCalled();
        });
      });
    });
  });

  it("prefers literal configured provider apiKey over media no-auth hook", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture(
          "openclaw-local-audio-literal-key",
          async ({ ctx, media, cache }) => {
            const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
              text: `literal:${req.apiKey}`,
              model: req.model,
            }));
            const cfg = createAudioCfg({
              provider: "local-audio",
              model: "whisper-local",
              providerConfig: {
                apiKey: "real-key",
                models: [],
              },
            });

            const result = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              agentDir,
              providerRegistry: buildProviderRegistry({
                "local-audio": createAudioProvider("local-audio", transcribeAudio, {
                  resolveAuth: () => ({
                    kind: "none",
                    source: "local-audio plugin no-auth",
                  }),
                }),
              }),
            });

            expect(result.decision.outcome).toBe("success");
            expect(result.outputs[0]?.text).toBe("literal:real-key");
            expect(transcribeAudio.mock.calls[0]?.[0].apiKey).toBe("real-key");
          },
        );
      });
    });
  });

  it("allows a media auth hook to provide an api key after normal auth misses", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture("openclaw-local-audio-hook-key", async ({ ctx, media, cache }) => {
          const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
            text: `hook:${req.apiKey}`,
            model: req.model,
          }));
          const cfg = createAudioCfg({ provider: "local-audio", model: "whisper-local" });

          const result = await runCapability({
            capability: "audio",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              "local-audio": createAudioProvider("local-audio", transcribeAudio, {
                resolveAuth: () => ({
                  kind: "api-key",
                  apiKey: "hook-key",
                  source: "local-audio media auth hook",
                }),
              }),
            }),
          });

          expect(result.decision.outcome).toBe("success");
          expect(result.outputs[0]?.text).toBe("hook:hook-key");
          expect(transcribeAudio.mock.calls[0]?.[0].auth).toEqual({
            kind: "api-key",
            apiKey: "hook-key",
            source: "local-audio media auth hook",
          });
        });
      });
    });
  });

  it("does not allow plugin-only media provider without explicit no-auth", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture("openclaw-local-audio-no-hook", async ({ ctx, media, cache }) => {
          const transcribeAudio = vi.fn(async () => ({
            text: "should not run",
            model: "whisper-local",
          }));
          const cfg = createAudioCfg({ provider: "local-audio", model: "whisper-local" });

          const result = await runCapability({
            capability: "audio",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              "local-audio": createAudioProvider("local-audio", transcribeAudio),
            }),
          });

          expect(result.decision.outcome).toBe("failed");
          expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain(
            'No API key found for provider "local-audio"',
          );
          expect(transcribeAudio).not.toHaveBeenCalled();
        });
      });
    });
  });

  it("does not allow plugin-only media provider when no-auth hook returns null", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture("openclaw-local-audio-null-hook", async ({ ctx, media, cache }) => {
          const transcribeAudio = vi.fn(async () => ({
            text: "should not run",
            model: "whisper-local",
          }));
          const cfg = createAudioCfg({ provider: "local-audio", model: "whisper-local" });

          const result = await runCapability({
            capability: "audio",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir,
            providerRegistry: buildProviderRegistry({
              "local-audio": createAudioProvider("local-audio", transcribeAudio, {
                resolveAuth: () => null,
              }),
            }),
          });

          expect(result.decision.outcome).toBe("failed");
          expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain(
            'No API key found for provider "local-audio"',
          );
          expect(transcribeAudio).not.toHaveBeenCalled();
        });
      });
    });
  });

  it("does not let plugin-only no-auth override an explicit missing profile", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture(
          "openclaw-local-audio-plugin-missing-profile",
          async ({ ctx, media, cache }) => {
            const transcribeAudio = vi.fn(async () => ({
              text: "should not run",
              model: "whisper-local",
            }));
            const cfg = createAudioCfg({
              provider: "local-audio",
              model: "whisper-local",
              entry: { profile: "missing-profile" },
            });

            const result = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              agentDir,
              providerRegistry: buildProviderRegistry({
                "local-audio": createAudioProvider("local-audio", transcribeAudio, {
                  resolveAuth: () => ({
                    kind: "none",
                    source: "local-audio plugin no-auth",
                  }),
                }),
              }),
            });

            expect(result.decision.outcome).toBe("failed");
            expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain(
              'No credentials found for profile "missing-profile"',
            );
            expect(transcribeAudio).not.toHaveBeenCalled();
          },
        );
      });
    });
  });

  it("does not let media no-auth override an explicit missing profile", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withAudioFixture(
          "openclaw-local-audio-missing-profile",
          async ({ ctx, media, cache }) => {
            const transcribeAudio = vi.fn(async () => ({
              text: "should not run",
              model: "whisper-local",
            }));
            const cfg = createAudioCfg({
              provider: "local-audio",
              model: "whisper-local",
              entry: { profile: "missing-profile" },
              providerConfig: {
                api: "openai-completions",
                baseUrl: "https://example.invalid/v1",
                models: [{ id: "whisper-local", input: ["audio"] }],
              },
            });

            const result = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              agentDir,
              providerRegistry: buildProviderRegistry({
                "local-audio": createAudioProvider("local-audio", transcribeAudio, {
                  resolveAuth: () => ({
                    kind: "none",
                    source: "local-audio plugin no-auth",
                  }),
                }),
              }),
            });

            expect(result.decision.outcome).toBe("failed");
            expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain(
              'No credentials found for profile "missing-profile"',
            );
            expect(transcribeAudio).not.toHaveBeenCalled();
          },
        );
      });
    });
  });

  it("allows explicit no-auth for plugin-only no-auth video provider", async () => {
    await withIsolatedAgentDir(async (agentDir) => {
      await withEnvAsync(AUTH_ENV, async () => {
        await withVideoFixture(
          "openclaw-local-video-plugin-only",
          async ({ ctx, media, cache }) => {
            const describeVideo = vi.fn(async (req: VideoDescriptionRequest) => ({
              text: `video:${req.auth?.kind}`,
              model: req.model,
            }));
            const cfg = createVideoCfg({ provider: "local-video", model: "video-local" });

            const result = await runCapability({
              capability: "video",
              cfg,
              ctx,
              attachments: cache,
              media,
              agentDir,
              providerRegistry: buildProviderRegistry({
                "local-video": createVideoProvider("local-video", describeVideo, {
                  resolveAuth: () => ({
                    kind: "none",
                    source: "local-video plugin no-auth",
                  }),
                }),
              }),
            });

            expect(result.decision.outcome).toBe("success");
            expect(result.outputs[0]?.text).toBe("video:none");
            expect(describeVideo).toHaveBeenCalledTimes(1);
            expect(describeVideo.mock.calls[0]?.[0].apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
            expect(describeVideo.mock.calls[0]?.[0].auth).toEqual({
              kind: "none",
              source: "local-video plugin no-auth",
            });
          },
        );
      });
    });
  });
});
