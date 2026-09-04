import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.js";
import { buildMediaUnderstandingRegistry } from "./provider-registry.js";
import { resolveAutoImageModel, runCapability } from "./runner.js";
import { clearMediaUnderstandingBinaryCacheForTests } from "./runner.test-support.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

const selection = vi.hoisted(() => {
  const providers: MediaUnderstandingProvider[] = [];
  return {
    providers,
    auth: vi.fn<(params: { provider: string }) => Promise<boolean>>(),
  };
});

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return {
    ...createAvailableModelAuthMockModule(),
    hasAvailableAuthForProvider: selection.auth,
  };
});

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => selection.providers,
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: async () => [],
  loadPreparedModelCatalog: async () => [],
}));

beforeEach(() => {
  selection.providers.length = 0;
  selection.auth.mockReset().mockResolvedValue(true);
  clearMediaUnderstandingBinaryCacheForTests();
});

afterEach(() => {
  selection.providers.length = 0;
  selection.auth.mockReset();
  clearMediaUnderstandingBinaryCacheForTests();
});

describe("automatic media selection", () => {
  it.each([
    { capability: "image", route: "active", model: "after-auth", provider: "google" },
    { capability: "image", route: "key", model: "before-auth", provider: "GEMINI" },
    { capability: "video", route: "active", model: "after-auth", provider: "google" },
    { capability: "video", route: "key", model: "before-auth", provider: "google" },
  ] as const)(
    "preserves $capability $route model capture and provider identity",
    async (scenario) => {
      const entered = createDeferred();
      const available = createDeferred<boolean>();
      const calls: string[] = [];
      selection.auth.mockImplementation(async ({ provider }) => {
        calls.push(provider);
        if (scenario.route === "key" && calls.length === 1) {
          return false;
        }
        entered.resolve();
        return available.promise;
      });
      selection.providers.push({
        id: "google",
        capabilities: ["image", "video"],
        describeImage: async ({ model }) => ({ text: "image", model }),
        describeVideo: async ({ model }) => ({ text: "video", model }),
      });
      const activeModel = { provider: " GEMINI ", model: "before-auth" };
      const cfg: OpenClawConfig = {};
      let outcome: { provider?: string; model?: string } | null = null;
      if (scenario.capability === "image") {
        const pending = resolveAutoImageModel({ cfg, activeModel });
        await entered.promise;
        activeModel.model = "after-auth";
        available.resolve(true);
        outcome = await pending;
      } else {
        await withVideoFixture("media-selection-timing", async ({ ctx, media, cache }) => {
          const pending = runCapability({
            capability: "video",
            cfg,
            ctx,
            media,
            attachments: cache,
            activeModel,
            providerRegistry: buildMediaUnderstandingRegistry(),
          });
          await entered.promise;
          activeModel.model = "after-auth";
          available.resolve(true);
          const result = await pending;
          expect(result.decision.outcome).toBe("success");
          expect(result.outputs).toHaveLength(1);
          outcome = result.outputs[0] ?? null;
        });
      }
      expect(outcome).toMatchObject({ model: scenario.model, provider: scenario.provider });
      expect(calls).toEqual(scenario.route === "key" ? ["google", "GEMINI"] : ["google"]);
    },
  );

  it.each(["provider-transcription", undefined])(
    "configured audio ignores the chat model with provider default %s",
    async (model) => {
      const seenModels: Array<string | undefined> = [];
      const provider: MediaUnderstandingProvider = {
        id: "selection-audio",
        capabilities: ["audio"],
        defaultModels: { audio: model },
        transcribeAudio: async (request) => {
          seenModels.push(request.model);
          return { text: "transcript", model: request.model };
        },
      };
      await withAudioFixture("media-selection-key-audio", async ({ ctx, media, cache }) => {
        const result = await runCapability({
          capability: "audio",
          cfg: {
            models: {
              providers: {
                [provider.id]: { baseUrl: "https://audio.example/v1", models: [] },
              },
            },
          },
          ctx,
          media,
          attachments: cache,
          providerRegistry: new Map([[provider.id, provider]]),
          activeModel: { provider: "chat-only", model: "chat-only-model" },
        });
        expect(result.decision.outcome).toBe("success");
        expect(seenModels).toEqual([model]);
        expect(selection.auth).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ provider: provider.id }),
        );
      });
    },
  );

  it("checks audio providers once in priority order until auth is available", async () => {
    const calls: string[] = [];
    selection.auth.mockImplementation(async ({ provider }) => {
      calls.push(provider);
      return provider === "second";
    });
    const providers = ["first", "second"].map((id, priority): MediaUnderstandingProvider => ({
      id,
      capabilities: ["audio"],
      autoPriority: { audio: priority },
      defaultModels: { audio: `${id}-transcription` },
      transcribeAudio: async ({ model }) => ({ text: id, model }),
    }));
    await withAudioFixture("media-selection-provider-order", async ({ ctx, media, cache }) => {
      const result = await runCapability({
        capability: "audio",
        cfg: {},
        ctx,
        media,
        attachments: cache,
        providerRegistry: new Map(providers.map((provider) => [provider.id, provider])),
      });
      expect(calls).toEqual(["first", "second"]);
      expect(result.outputs).toEqual([
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          provider: "second",
          model: "second-transcription",
          text: "second",
        },
      ]);
      expect(result.decision.outcome).toBe("success");
    });
  });
});
