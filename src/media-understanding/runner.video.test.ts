import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runCapability } from "./runner.js";
import { withVideoFixture } from "./runner.test-utils.js";

describe("runCapability video provider wiring", () => {
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
              video: {
                enabled: true,
                baseUrl: "https://config.example/v1",
                headers: { "X-Config": "2" },
                models: [
                  {
                    provider: "moonshot",
                    model: "kimi-k2.5",
                    baseUrl: "https://entry.example/v1",
                    headers: { "X-Entry": "3" },
                  },
                ],
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
          providerRegistry: new Map([
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

        expect(result.outputs[0]?.text).toBe("video ok");
        expect(result.outputs[0]?.provider).toBe("moonshot");
        expect(seenBaseUrl).toBe("https://entry.example/v1");
        expect(seenHeaders).toMatchObject({
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
          PI_CODING_AGENT_DIR: isolatedAgentDir,
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
              providerRegistry: new Map([
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
                    describeVideo: async () => ({ text: "moonshot", model: "kimi-k2.5" }),
                  },
                ],
              ]),
            });

            expect(result.decision.outcome).toBe("success");
            expect(result.outputs[0]?.provider).toBe("moonshot");
            expect(result.outputs[0]?.text).toBe("moonshot");
          });
        },
      );
    });
  });
});
