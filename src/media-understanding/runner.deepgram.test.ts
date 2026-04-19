import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

describe("runCapability deepgram provider options", () => {
  it("merges provider options, headers, and baseUrl overrides", async () => {
    await withAudioFixture("openclaw-deepgram", async ({ ctx, media, cache }) => {
      let seenQuery: Record<string, string | number | boolean> | undefined;
      let seenBaseUrl: string | undefined;
      let seenHeaders: Record<string, string> | undefined;
      let seenRequest:
        | import("../agents/provider-request-config.js").ProviderRequestTransportOverrides
        | undefined;

      const providerRegistry = buildProviderRegistry({
        deepgram: {
          id: "deepgram",
          capabilities: ["audio"],
          transcribeAudio: async (req) => {
            seenQuery = req.query;
            seenBaseUrl = req.baseUrl;
            seenHeaders = req.headers;
            seenRequest = req.request;
            return { text: "ok", model: req.model };
          },
        },
      });

      const cfg = {
        models: {
          providers: {
            deepgram: {
              baseUrl: "https://provider.example",
              apiKey: "test-key",
              headers: {
                "X-Provider": "1",
                "X-Provider-Managed": "secretref-managed",
              },
              models: [],
            },
          },
        },
        tools: {
          media: {
            audio: {
              enabled: true,
              baseUrl: "https://config.example",
              headers: {
                "X-Config": "2",
                "X-Config-Managed": "secretref-env:DEEPGRAM_HEADER_TOKEN",
              },
              request: {
                headers: {
                  "X-Config-Request": "cfg",
                },
                auth: {
                  mode: "header",
                  headerName: "x-config-auth",
                  value: "cfg-secret",
                },
              },
              providerOptions: {
                deepgram: {
                  detect_language: true,
                  punctuate: true,
                },
              },
              deepgram: { smartFormat: true },
              models: [
                {
                  provider: "deepgram",
                  model: "nova-3",
                  baseUrl: "https://entry.example",
                  headers: {
                    "X-Entry": "3",
                    "X-Entry-Managed": "secretref-managed",
                  },
                  request: {
                    headers: {
                      "X-Entry-Request": "entry",
                    },
                    tls: {
                      serverName: "deepgram.internal",
                    },
                  },
                  providerOptions: {
                    deepgram: {
                      detectLanguage: false,
                      punctuate: false,
                      smart_format: true,
                    },
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });
      expect(result.outputs[0]?.text).toBe("ok");
      expect(seenBaseUrl).toBe("https://entry.example");
      expect(seenHeaders).toMatchObject({
        "X-Provider": "1",
        "X-Provider-Managed": "secretref-managed",
        "X-Config": "2",
        "X-Config-Managed": "secretref-env:DEEPGRAM_HEADER_TOKEN",
        "X-Entry": "3",
        "X-Entry-Managed": "secretref-managed",
      });
      expect(seenQuery).toMatchObject({
        detect_language: false,
        punctuate: false,
        smart_format: true,
      });
      expect((seenQuery as Record<string, unknown>)["detectLanguage"]).toBeUndefined();
      expect(seenRequest).toEqual({
        headers: {
          "X-Config-Request": "cfg",
          "X-Entry-Request": "entry",
        },
        auth: {
          mode: "header",
          headerName: "x-config-auth",
          value: "cfg-secret",
        },
        tls: {
          serverName: "deepgram.internal",
        },
      });
    });
  });
});
