import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearMediaUnderstandingBinaryCacheForTests, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

function createProviderRegistry(
  providers: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  // Keep these tests focused on auto-entry selection instead of paying the full
  // plugin capability registry build for every stub provider setup.
  return new Map(Object.entries(providers));
}

function createOpenAiAudioProvider(
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>,
) {
  return createProviderRegistry({
    openai: {
      id: "openai",
      capabilities: ["audio"],
      transcribeAudio,
    },
  });
}

function createOpenAiAudioCfg(extra?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key",
          models: [],
        },
      },
    },
    ...extra,
  } as unknown as OpenClawConfig;
}

async function createMockExecutable(dir: string, name: string) {
  const executablePath = path.join(dir, name);
  await fs.writeFile(executablePath, "#!/bin/sh\necho mocked-local-whisper\n", { mode: 0o755 });
  return executablePath;
}

async function runAutoAudioCase(params: {
  transcribeAudio: (req: AudioTranscriptionRequest) => Promise<{ text: string; model: string }>;
  cfgExtra?: Partial<OpenClawConfig>;
}) {
  let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withAudioFixture("openclaw-auto-audio", async ({ ctx, media, cache }) => {
    const providerRegistry = createOpenAiAudioProvider(params.transcribeAudio);
    const cfg = createOpenAiAudioCfg(params.cfgExtra);
    runResult = await runCapability({
      capability: "audio",
      cfg,
      ctx,
      attachments: cache,
      media,
      providerRegistry,
    });
  });
  if (!runResult) {
    throw new Error("Expected auto audio case result");
  }
  return runResult;
}

describe("runCapability auto audio entries", () => {
  it("uses provider keys to auto-enable audio transcription", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
    });
    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("gpt-4o-transcribe");
    expect(result.decision.outcome).toBe("success");
  });

  it("uses the provider audio default instead of the active Codex chat model", async () => {
    let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
    let seenModel: string | undefined;

    await withAudioFixture("openclaw-auto-audio-codex", async ({ ctx, media, cache }) => {
      const providerRegistry = createProviderRegistry({
        "openai-codex": {
          id: "openai-codex",
          capabilities: ["image", "audio"],
          defaultModels: { image: "gpt-5.5", audio: "gpt-4o-transcribe" },
          transcribeAudio: async (req) => {
            seenModel = req.model;
            return { text: "codex audio", model: req.model ?? "unknown" };
          },
        },
      });
      const cfg = {
        models: {
          providers: {
            "openai-codex": {
              apiKey: "codex-test-key", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;

      runResult = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
        activeModel: { provider: "openai-codex", model: "gpt-5.5" },
      });
    });

    expect(runResult?.outputs[0]).toMatchObject({
      provider: "openai-codex",
      model: "gpt-4o-transcribe",
      text: "codex audio",
    });
    expect(seenModel).toBe("gpt-4o-transcribe");
  });

  it("prefers provider keys over auto-detected local whisper", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auto-audio-bin-"));
    try {
      await createMockExecutable(binDir, "whisper");
      clearMediaUnderstandingBinaryCacheForTests();
      let seenModel: string | undefined;
      const result = await withEnvAsync(
        {
          PATH: binDir,
          SHERPA_ONNX_MODEL_DIR: undefined,
          WHISPER_CPP_MODEL: undefined,
          GEMINI_API_KEY: undefined,
        },
        async () =>
          await runAutoAudioCase({
            transcribeAudio: async (req) => {
              seenModel = req.model;
              return { text: "provider transcription", model: req.model ?? "unknown" };
            },
          }),
      );

      expect(result.outputs[0]?.provider).toBe("openai");
      expect(result.outputs[0]?.text).toBe("provider transcription");
      expect(seenModel).toBe("gpt-4o-transcribe");
    } finally {
      clearMediaUnderstandingBinaryCacheForTests();
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("skips auto audio when disabled", async () => {
    const result = await runAutoAudioCase({
      transcribeAudio: async () => ({
        text: "ok",
        model: "whisper-1",
      }),
      cfgExtra: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });
    expect(result.outputs).toHaveLength(0);
    expect(result.decision.outcome).toBe("disabled");
  });

  it("prefers explicitly configured audio model entries", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
      cfgExtra: {
        tools: {
          media: {
            audio: {
              models: [{ provider: "openai", model: "whisper-1" }],
            },
          },
        },
      },
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("whisper-1");
  });

  it("lets per-request transcription hints override configured model-entry hints", async () => {
    let seenLanguage: string | undefined;
    let seenPrompt: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenLanguage = req.language;
        seenPrompt = req.prompt;
        return { text: "ok", model: req.model ?? "unknown" };
      },
      cfgExtra: {
        tools: {
          media: {
            audio: {
              enabled: true,
              prompt: "configured prompt",
              language: "fr",
              _requestPromptOverride: "Focus on names",
              _requestLanguageOverride: "en",
              models: [
                {
                  provider: "openai",
                  model: "whisper-1",
                  prompt: "entry prompt",
                  language: "de",
                },
              ],
            },
          },
        },
      } as Partial<OpenClawConfig>,
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenLanguage).toBe("en");
    expect(seenPrompt).toBe("Focus on names");
  });

  it("uses mistral when only mistral key is configured", async () => {
    const isolatedAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-agent-"));
    let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
    try {
      await withEnvAsync(
        {
          OPENAI_API_KEY: undefined,
          GROQ_API_KEY: undefined,
          DEEPGRAM_API_KEY: undefined,
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          MISTRAL_API_KEY: "mistral-test-key", // pragma: allowlist secret
          OPENCLAW_AGENT_DIR: isolatedAgentDir,
          PI_CODING_AGENT_DIR: isolatedAgentDir,
        },
        async () => {
          await withAudioFixture("openclaw-auto-audio-mistral", async ({ ctx, media, cache }) => {
            const providerRegistry = createProviderRegistry({
              openai: {
                id: "openai",
                capabilities: ["audio"],
                transcribeAudio: async () => ({
                  text: "openai",
                  model: "gpt-4o-transcribe",
                }),
              },
              mistral: {
                id: "mistral",
                capabilities: ["audio"],
                transcribeAudio: async (req) => ({
                  text: "mistral",
                  model: req.model ?? "unknown",
                }),
              },
            });
            const cfg = {
              models: {
                providers: {
                  mistral: {
                    apiKey: "mistral-test-key", // pragma: allowlist secret
                    models: [],
                  },
                },
              },
              tools: {
                media: {
                  audio: {
                    enabled: true,
                  },
                },
              },
            } as unknown as OpenClawConfig;

            runResult = await runCapability({
              capability: "audio",
              cfg,
              ctx,
              attachments: cache,
              media,
              providerRegistry,
            });
          });
        },
      );
    } finally {
      await fs.rm(isolatedAgentDir, { recursive: true, force: true });
    }
    if (!runResult) {
      throw new Error("Expected auto audio mistral result");
    }
    expect(runResult.decision.outcome).toBe("success");
    expect(runResult.outputs[0]?.provider).toBe("mistral");
    expect(runResult.outputs[0]?.model).toBe("voxtral-mini-latest");
    expect(runResult.outputs[0]?.text).toBe("mistral");
  });
});
