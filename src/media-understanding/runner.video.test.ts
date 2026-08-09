// Video runner tests cover provider request wiring, auth/config precedence, and
// provider output handling for video attachments.
import { describe, expect, it, vi } from "vitest";
import {
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "../../packages/media-understanding-common/src/format.js";
import type { OpenClawConfig } from "../config/types.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runCapability } from "./runner.js";
import { withVideoFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

vi.mock("../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRoots: () => undefined,
}));

vi.mock("../agents/api-key-rotation.js", () => ({
  collectProviderApiKeysForExecution: ({ primaryApiKey }: { primaryApiKey?: string }) => [
    primaryApiKey ?? "test-key",
  ],
  executeWithApiKeyRotation: async <T>({ execute }: { execute: (apiKey: string) => Promise<T> }) =>
    execute("test-key"),
}));

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

type CapabilityResult = Awaited<ReturnType<typeof runCapability>>;

function requireCapabilityOutput(result: CapabilityResult, index: number) {
  const output = result.outputs[index];
  if (!output) {
    throw new Error(`expected media-understanding output at index ${index}`);
  }
  return output;
}

describe("runCapability video provider wiring", () => {
  it("truncates provider output without splitting a boundary emoji", async () => {
    await withVideoFixture("openclaw-video-utf16-output", async ({ ctx, media, cache }) => {
      const prefix = "v".repeat(79);
      const result = await runCapability({
        capability: "video",
        cfg: {
          models: {
            providers: {
              moonshot: {
                apiKey: "test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              models: [
                {
                  provider: "moonshot",
                  model: "kimi-k2.5",
                  maxChars: 80,
                  capabilities: ["video"],
                },
              ],
              video: {
                enabled: true,
              },
            },
          },
        } as unknown as OpenClawConfig,
        ctx,
        attachments: cache,
        media,
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          [
            "moonshot",
            {
              id: "moonshot",
              capabilities: ["video"],
              describeVideo: async (req) => ({
                text: `${prefix}${String.fromCodePoint(0x1f600)}tail`,
                model: req.model,
              }),
            },
          ],
        ]),
      });

      const output = requireCapabilityOutput(result, 0);
      expect(output.text).toBe(prefix);
      expect(output.text).not.toContain(String.fromCharCode(0xd83d));
    });
  });

  it("merges video baseUrl and headers with entry precedence", async () => {
    let seenBaseUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;

    await withTempDir({ prefix: "openclaw-video-auth-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-merge", async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              moonshot: {
                auth: "api-key",
                apiKey: "provider-key", // pragma: allowlist secret
                baseUrl: "https://provider.example/v1",
                headers: { "X-Provider": "1" },
                models: [],
              },
            },
          },
          tools: {
            media: {
              models: [
                {
                  provider: "moonshot",
                  model: "kimi-k2.5",
                  baseUrl: "https://entry.example/v1",
                  headers: { "X-Entry": "3" },
                  capabilities: ["video"],
                },
              ],
              video: {
                enabled: true,
                baseUrl: "https://config.example/v1",
                headers: { "X-Config": "2" },
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          agentDir: isolatedAgentDir,
          attachments: cache,
          media,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            [
              "moonshot",
              {
                id: "moonshot",
                capabilities: ["video"],
                describeVideo: async (req) => {
                  seenBaseUrl = req.baseUrl;
                  seenHeaders = req.headers;
                  return { text: "video ok", model: req.model };
                },
              },
            ],
          ]),
        });

        const output = requireCapabilityOutput(result, 0);
        expect(output.text).toBe("video ok");
        expect(output.provider).toBe("moonshot");
        expect(seenBaseUrl).toBe("https://entry.example/v1");
        expect(seenHeaders).toEqual({
          "X-Provider": "1",
          "X-Config": "2",
          "X-Entry": "3",
        });
      });
    });
  });

  it("auto-selects moonshot for video when google is unavailable", async () => {
    await withTempDir({ prefix: "openclaw-video-agent-" }, async (isolatedAgentDir) => {
      await withEnvAsync(
        {
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          MOONSHOT_API_KEY: undefined,
          OPENCLAW_AGENT_DIR: isolatedAgentDir,
        },
        async () => {
          await withVideoFixture("openclaw-video-auto-moonshot", async ({ ctx, media, cache }) => {
            const cfg = {
              models: {
                providers: {
                  moonshot: {
                    auth: "api-key",
                    apiKey: "moonshot-key", // pragma: allowlist secret
                    models: [],
                  },
                },
              },
              tools: {
                media: {
                  video: {
                    enabled: true,
                  },
                },
              },
            } as unknown as OpenClawConfig;

            const result = await runCapability({
              capability: "video",
              cfg,
              ctx,
              agentDir: isolatedAgentDir,
              attachments: cache,
              media,
              providerRegistry: new Map<string, MediaUnderstandingProvider>([
                [
                  "google",
                  {
                    id: "google",
                    capabilities: ["video"],
                    describeVideo: async () => ({ text: "google" }),
                  },
                ],
                [
                  "moonshot",
                  {
                    id: "moonshot",
                    capabilities: ["video"],
                    defaultModels: { video: "kimi-k2.5" },
                    describeVideo: async (req) => ({ text: "moonshot", model: req.model }),
                  },
                ],
              ]),
            });

            expect(result.decision.outcome).toBe("success");
            const output = requireCapabilityOutput(result, 0);
            expect(output.provider).toBe("moonshot");
            expect(output.text).toBe("moonshot");
          });
        },
      );
    });
  });

  it("uses the provider video default when the active provider has no model", async () => {
    let seenModel: string | undefined;

    await withTempDir({ prefix: "openclaw-video-active-provider-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-active-default", async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              moonshot: {
                auth: "api-key",
                apiKey: "moonshot-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                enabled: true,
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          agentDir: isolatedAgentDir,
          attachments: cache,
          media,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            [
              "moonshot",
              {
                id: "moonshot",
                capabilities: ["video"],
                defaultModels: { video: "kimi-k2.5" },
                describeVideo: async (req) => {
                  seenModel = req.model;
                  return { text: "moonshot", model: req.model };
                },
              },
            ],
          ]),
          activeModel: { provider: "moonshot" },
        });

        expect(result.decision.outcome).toBe("success");
        const output = requireCapabilityOutput(result, 0);
        expect(output.provider).toBe("moonshot");
        expect(output.model).toBe("kimi-k2.5");
        expect(seenModel).toBe("kimi-k2.5");
      });
    });
  });

  it("preserves self-defaulting video providers without registry model metadata", async () => {
    let seenModel: string | undefined;

    await withTempDir(
      { prefix: "openclaw-video-no-default-provider-" },
      async (isolatedAgentDir) => {
        await withVideoFixture("openclaw-video-no-default", async ({ ctx, media, cache }) => {
          const cfg = {
            models: {
              providers: {
                moonshot: {
                  auth: "api-key",
                  apiKey: "moonshot-key", // pragma: allowlist secret
                  models: [],
                },
              },
            },
            tools: {
              media: {
                video: {
                  enabled: true,
                },
              },
            },
          } as unknown as OpenClawConfig;

          const result = await runCapability({
            capability: "video",
            cfg,
            ctx,
            agentDir: isolatedAgentDir,
            attachments: cache,
            media,
            providerRegistry: new Map<string, MediaUnderstandingProvider>([
              [
                "moonshot",
                {
                  id: "moonshot",
                  capabilities: ["video"],
                  describeVideo: async (req) => {
                    seenModel = req.model;
                    return { text: "moonshot", model: "provider-default" };
                  },
                },
              ],
            ]),
            activeModel: { provider: "moonshot" },
          });

          expect(result.decision.outcome).toBe("success");
          const output = requireCapabilityOutput(result, 0);
          expect(output.provider).toBe("moonshot");
          expect(output.model).toBe("provider-default");
          expect(seenModel).toBeUndefined();
        });
      },
    );
  });

  it("resolves provider registry defaultModels.video when a config entry has no explicit model", async () => {
    let seenModel: string | undefined;

    await withTempDir({ prefix: "openclaw-video-entry-default-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-entry-default", async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              moonshot: {
                auth: "api-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              models: [{ provider: "moonshot", capabilities: ["video"] }],
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          agentDir: isolatedAgentDir,
          attachments: cache,
          media,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            [
              "moonshot",
              {
                id: "moonshot",
                capabilities: ["video"],
                defaultModels: { video: "kimi-k2.5" },
                describeVideo: async (req) => {
                  seenModel = req.model;
                  return { text: "moonshot", model: req.model };
                },
              },
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        const output = requireCapabilityOutput(result, 0);
        expect(output.provider).toBe("moonshot");
        expect(output.model).toBe("kimi-k2.5");
        expect(seenModel).toBe("kimi-k2.5");
      });
    });
  });

  it("does not use provider api config as video auth modelApi", async () => {
    const modelAuth = await import("../agents/model-auth.js");
    const resolveApiKeyForProvider = vi.mocked(modelAuth.resolveApiKeyForProvider);
    resolveApiKeyForProvider.mockClear();

    await withTempDir({ prefix: "openclaw-video-provider-api-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-provider-api", async ({ ctx, media, cache }) => {
        let seenApiKey: string | undefined;
        const cfg = {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                models: [],
              },
            },
          },
          tools: {
            media: {
              models: [{ provider: "openai", model: "video-model", capabilities: ["video"] }],
              video: {
                enabled: true,
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          agentDir: isolatedAgentDir,
          attachments: cache,
          media,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            [
              "openai",
              {
                id: "openai",
                capabilities: ["video"],
                describeVideo: async (req) => {
                  seenApiKey = req.apiKey;
                  return { text: "video ok", model: req.model };
                },
              },
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenApiKey).toBe("test-key");
      });
    });

    const firstCall = resolveApiKeyForProvider.mock.calls[0]?.[0];
    expect(firstCall?.provider).toBe("openai");
    expect(firstCall?.modelApi).toBeUndefined();
  });
});

describe("runCapability provider output decisions", () => {
  const outputs = [
    { label: "empty", text: "" },
    { label: "whitespace", text: " \t\n" },
    { label: "usable", text: "  usable primary output  " },
  ] as const;
  const cases = (["audio", "video", "image"] as const).flatMap((capability) =>
    outputs.flatMap((output) =>
      (output.text.trim() ? [true] : [true, false]).map((configureFallback) => ({
        capability,
        configureFallback,
        label: output.label,
        text: output.text,
      })),
    ),
  );

  it.each(cases)(
    "handles $label $capability provider output with fallback=$configureFallback",
    async ({ capability, configureFallback, text }) => {
      const extension = capability === "image" ? "png" : capability === "video" ? "mp4" : "wav";
      const mime = `${capability}/${extension}`;
      const buffer =
        capability === "image"
          ? Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAuMBg4n8tLwAAAAASUVORK5CYII=",
              "base64",
            )
          : Buffer.alloc(2048, 1);
      const primary = vi.fn(async () => ({ text, model: "primary-model" }));
      const fallback = vi.fn(async () => ({
        text: "usable fallback output",
        model: "fallback-model",
      }));
      const createProvider = (
        id: string,
        run: () => Promise<{ text: string; model: string }>,
      ): MediaUnderstandingProvider => ({
        id,
        capabilities: [capability],
        ...(capability === "audio"
          ? { transcribeAudio: run }
          : capability === "video"
            ? { describeVideo: run }
            : { describeImage: run }),
      });
      const providerIds = ["qa-primary", ...(configureFallback ? ["qa-fallback"] : [])];
      const cfg = {
        models: {
          providers: Object.fromEntries(
            providerIds.map((provider) => [provider, { apiKey: "test-key", models: [] }]),
          ),
        },
        tools: {
          media: {
            models: providerIds.map((provider) => ({
              provider,
              model: provider === "qa-primary" ? "primary-model" : "fallback-model",
              capabilities: [capability],
            })),
            [capability]: { enabled: true },
          },
        },
      } as unknown as OpenClawConfig;

      const result = await runCapability({
        capability,
        cfg,
        ctx: { Body: "" },
        attachments: {
          getBuffer: async () => ({
            buffer,
            mime,
            fileName: `fixture.${extension}`,
            size: buffer.length,
          }),
        } as unknown as Parameters<typeof runCapability>[0]["attachments"],
        media: [{ index: 0, kind: capability, mime }],
        agentDir: "/tmp/openclaw-media-provider-output-test",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["qa-primary", createProvider("qa-primary", primary)],
          ["qa-fallback", createProvider("qa-fallback", fallback)],
        ]),
      });

      const usablePrimary = text.trim();
      const expectedText = usablePrimary || (configureFallback ? "usable fallback output" : "");
      const expectedFallbackCalls = !usablePrimary && configureFallback ? 1 : 0;
      expect(primary).toHaveBeenCalledOnce();
      expect(fallback).toHaveBeenCalledTimes(expectedFallbackCalls);
      expect(result.outputs.map((output) => output.text)).toEqual(
        expectedText ? [expectedText] : [],
      );
      expect(result.decision.outcome).toBe(expectedText ? "success" : "skipped");

      const attempts = result.decision.attachments[0]?.attempts.map(
        ({ provider, outcome, reason }) => ({
          provider,
          outcome,
          ...(reason ? { reason } : {}),
        }),
      );
      expect(attempts).toEqual([
        usablePrimary
          ? { provider: "qa-primary", outcome: "success" }
          : { provider: "qa-primary", outcome: "skipped", reason: "empty output" },
        ...(expectedFallbackCalls ? [{ provider: "qa-fallback", outcome: "success" }] : []),
      ]);

      if (capability === "audio") {
        expect(formatMediaUnderstandingBody({ outputs: result.outputs })).toBe(
          expectedText ? `[Audio]\nTranscript:\n${expectedText}` : "",
        );
        if (expectedText) {
          expect(formatAudioTranscripts(result.outputs)).toBe(expectedText);
        }
      }
    },
  );
});
