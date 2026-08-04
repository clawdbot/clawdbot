import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import type {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import type { ImageCompressionPolicy, WebMediaResult } from "../../media/web-media.js";
import type {
  describeImageWithModel,
  describeImagesWithModel,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { resolveBundledStaticCatalogModel } from "../embedded-agent-runner/model.static-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import type {
  coerceImageAssistantText,
  decodeDataUrl,
  hasImageReasoningOnlyResponse,
  ImageModelConfig,
} from "./image-tool.helpers.js";
import "./image-tool.js";

type ResolveModelAsync = (typeof import("../embedded-agent-runner/model.js"))["resolveModelAsync"];

type ImageToolLoadWebMediaOptions = {
  maxBytes?: number;
  sandboxValidated?: boolean;
  readFile?: (filePath: string) => Promise<Buffer>;
  imageCompression?: ImageCompressionPolicy;
  localRoots?: readonly string[] | "any";
  inboundRoots?: readonly string[];
  ssrfPolicy?: ReturnType<
    (typeof import("./media-tool-shared.js"))["resolveRemoteMediaSsrfPolicy"]
  >;
  readIdleTimeoutMs?: number;
};

type ImageWebMediaRuntime = {
  loadWebMedia(mediaUrl: string, options?: ImageToolLoadWebMediaOptions): Promise<WebMediaResult>;
  optimizeImageBufferForWebMedia: (typeof import("../../media/web-media.js"))["optimizeImageBufferForWebMedia"];
};

type ResolveImageCompressionPolicy = (params: {
  cfg?: OpenClawConfig;
  imageModelConfig?: ImageModelConfig | null;
  modelOverride?: string;
  imageCount: number;
  agentDir?: string;
  workspaceDir?: string;
}) => Promise<ImageCompressionPolicy>;

type ImageToolProviderDeps = {
  buildProviderRegistry: typeof buildMediaUnderstandingRegistry;
  getMediaUnderstandingProvider: typeof getMediaUnderstandingProvider;
  describeImageWithModel: typeof describeImageWithModel;
  describeImagesWithModel: typeof describeImagesWithModel;
  resolveAutoMediaKeyProviders: typeof resolveAutoMediaKeyProviders;
  resolveDefaultMediaModel: typeof resolveDefaultMediaModel;
  resolveBundledStaticCatalogModel: typeof resolveBundledStaticCatalogModel;
  resolveModelAsync: ResolveModelAsync;
  resolveRegisteredMediaUnderstandingProvider(params: {
    providerId: string;
    cfg?: OpenClawConfig;
  }): MediaUnderstandingProvider | undefined;
  resolveImageCompressionPolicy: ResolveImageCompressionPolicy;
  loadImageWebMediaRuntime: () => Promise<ImageWebMediaRuntime>;
};

type ImageToolTestApi = {
  decodeDataUrl: typeof decodeDataUrl;
  coerceImageAssistantText: typeof coerceImageAssistantText;
  hasImageReasoningOnlyResponse: typeof hasImageReasoningOnlyResponse;
  resolveImageToolMaxTokens(
    modelMaxTokens: number | undefined,
    requestedMaxTokens?: number,
  ): number;
  resolveImageCompressionPolicy: ResolveImageCompressionPolicy;
  setProviderDepsForTest(overrides?: Partial<ImageToolProviderDeps>): void;
  resolveImageModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir: string;
    workspaceDir?: string;
    authStore?: AuthProfileStore;
    preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  }): ImageModelConfig | null;
};

function getTestApi(): ImageToolTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.imageToolTestApi")];
  if (!api) {
    throw new Error("image tool test API is unavailable");
  }
  return api as ImageToolTestApi;
}

export const testing = getTestApi();
export const resolveImageModelConfigForTool: ImageToolTestApi["resolveImageModelConfigForTool"] = (
  params,
) => testing.resolveImageModelConfigForTool(params);
