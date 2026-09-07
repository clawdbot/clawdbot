// Image execution loads only the selected fallback owner, while prepared media
// families and config-backed generic models keep their existing dispatch paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildMediaUnderstandingRegistry } from "../../media-understanding/provider-registry.js";
import type { MediaUnderstandingProvider } from "../../media-understanding/types.js";
import { createImageTool } from "./image-tool.js";
import { testing } from "./image-tool.test-support.js";

const genericDescribe = vi.hoisted(() => vi.fn());
vi.mock("../../media-understanding/image-runtime.js", () => ({
  describeImageWithModel: genericDescribe,
  describeImagesWithModel: genericDescribe,
  describeImageWithModelPayloadTransform: genericDescribe,
  describeImagesWithModelPayloadTransform: genericDescribe,
}));

const resolveProvider =
  vi.fn<
    NonNullable<
      NonNullable<
        Parameters<typeof testing.setProviderDepsForTest>[0]
      >["resolveRegisteredMediaUnderstandingProvider"]
    >
  >();
const image = "data:image/png;base64,aW1hZ2U=";

function provider(id: string, text = id): MediaUnderstandingProvider {
  return { id, capabilities: ["image"], describeImage: vi.fn(async () => ({ text })) };
}

async function executeImage(params: {
  primary?: string;
  fallbacks?: string[];
  preparedProviders?: MediaUnderstandingProvider[];
  configuredProvider?: string;
}) {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        imageModel: {
          primary: params.primary ?? "selected/vision",
          ...(params.fallbacks ? { fallbacks: params.fallbacks } : {}),
        },
      },
    },
    ...(params.configuredProvider
      ? {
          models: {
            providers: {
              [params.configuredProvider]: {
                baseUrl: "https://example.invalid/v1",
                models: [
                  {
                    id: "vision",
                    name: "Vision",
                    reasoning: false,
                    input: ["text", "image"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        }
      : {}),
  };
  const tool = createImageTool({
    config,
    agentDir: "/image-provider-loading-test",
    ...(params.preparedProviders
      ? {
          preparedModelRuntime: {
            mediaCapabilityProviders: { mediaUnderstandingProviders: params.preparedProviders },
          } as never,
        }
      : {}),
  });
  if (!tool) {
    throw new Error("expected configured image tool");
  }
  return await tool.execute("image-loading", { path: image });
}

describe("image tool provider loading", () => {
  beforeEach(() => {
    genericDescribe.mockReset().mockResolvedValue({ text: "generic image" });
    resolveProvider.mockReset();
    testing.setProviderDepsForTest({
      buildProviderRegistry: (overrides, cfg, preparedProviders) => {
        // An unrelated plugin may fail or block during broad discovery. Keep the
        // real registry hydration but make that unwanted cold path observable.
        if (preparedProviders === undefined) {
          throw new Error("unrelated media plugin failed to initialize");
        }
        return buildMediaUnderstandingRegistry(overrides, cfg, preparedProviders);
      },
      resolveRegisteredMediaUnderstandingProvider: resolveProvider,
      resolveImageCompressionPolicy: async () => ({ imageCount: 1 }),
      loadImageWebMediaRuntime: async () => ({
        loadWebMedia: async () => {
          throw new Error("expected inline image");
        },
        optimizeImageBufferForWebMedia: async ({ buffer, contentType }) => ({
          buffer,
          contentType,
          kind: "image",
        }),
      }),
    });
  });

  afterEach(() => testing.setProviderDepsForTest());

  it("executes the selected provider without initializing unused fallbacks", async () => {
    resolveProvider.mockReturnValue(provider("selected"));
    const result = await executeImage({ fallbacks: ["unused/vision"] });
    expect(result.content).toEqual([{ type: "text", text: "selected" }]);
    expect(resolveProvider.mock.calls.map(([params]) => params.providerId)).toEqual(["selected"]);
    expect(genericDescribe).not.toHaveBeenCalled();
  });

  it("loads the next fallback owner only after the primary fails", async () => {
    const primary = provider("selected");
    vi.mocked(primary.describeImage!).mockRejectedValue(new Error("rate limit"));
    resolveProvider.mockImplementation(({ providerId }) =>
      providerId === "selected" ? primary : provider(providerId),
    );
    const result = await executeImage({ fallbacks: ["fallback/vision", "unused/vision"] });
    expect(result.content).toEqual([{ type: "text", text: "fallback" }]);
    expect(resolveProvider.mock.calls.map(([params]) => params.providerId)).toEqual([
      "selected",
      "fallback",
    ]);
  });

  it.each([false, true])("preserves owner aliases with prepared=%s", async (prepared) => {
    const owner = { ...provider("owner"), aliases: ["selected"] };
    resolveProvider.mockReturnValue(owner);
    const result = await executeImage(prepared ? { preparedProviders: [owner] } : {});
    expect(result.content).toEqual([{ type: "text", text: "owner" }]);
    expect(resolveProvider).toHaveBeenCalledTimes(prepared ? 0 : 1);
    expect(owner.describeImage).toHaveBeenCalledOnce();
    expect(genericDescribe).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unprepared", preparedProviders: undefined },
    { name: "an empty prepared family", preparedProviders: [] },
  ])("keeps config-backed generic image dispatch with $name", async ({ preparedProviders }) => {
    const result = await executeImage({ configuredProvider: "selected", preparedProviders });
    expect(result.content).toEqual([{ type: "text", text: "generic image" }]);
    expect(genericDescribe).toHaveBeenCalledWith(expect.objectContaining({ provider: "selected" }));
    expect(resolveProvider).toHaveBeenCalledTimes(preparedProviders ? 0 : 1);
  });

  it("surfaces the generic runtime error for an unknown provider", async () => {
    genericDescribe.mockRejectedValue(new Error("Unknown model: unknown/vision"));
    await expect(executeImage({ primary: "unknown/vision" })).rejects.toThrow(
      "Unknown model: unknown/vision",
    );
    expect(resolveProvider.mock.calls.map(([params]) => params.providerId)).toEqual(["unknown"]);
  });
});
