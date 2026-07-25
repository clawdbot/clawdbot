// Video Generation Providers.Live.Test.Ts tests cover video generation providers plugin behavior.
import {
  resolveApiKeyForProvider,
  resolveDefaultAgentDir,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
  isModelNotFoundErrorMessage,
  isOverloadedErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
  isTruthyEnvValue,
} from "openclaw/plugin-sdk/test-live";
import { collectProviderApiKeys, getShellEnvAppliedKeys } from "openclaw/plugin-sdk/test-live-auth";
import {
  DEFAULT_LIVE_VIDEO_MODELS,
  canRunBufferBackedImageToVideoLiveLane,
  canRunBufferBackedVideoToVideoLiveLane,
  encodePngRgba,
  fillPixel,
  normalizeVideoGenerationDuration,
  parseCsvFilter,
  parseProviderModelMap,
  parseVideoGenerationModelRef,
  redactLiveApiKey,
  resolveConfiguredLiveVideoModels,
  resolveLiveVideoAuthStore,
  resolveLiveVideoResolution,
} from "openclaw/plugin-sdk/test-media-generation";
import type {
  GeneratedVideoAsset,
  VideoGenerationMode,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/test-media-generation";
import { describe, expect, it } from "vitest";
import alibabaPlugin from "./alibaba/index.js";
import byteplusPlugin from "./byteplus/index.js";
import deepinfraPlugin from "./deepinfra/index.js";
import falPlugin from "./fal/index.js";
import googlePlugin from "./google/index.js";
import minimaxPlugin from "./minimax/index.js";
import openaiPlugin from "./openai/index.js";
import openrouterPlugin from "./openrouter/index.js";
import pixversePlugin from "./pixverse/index.js";
import qwenPlugin from "./qwen/index.js";
import runwayPlugin from "./runway/index.js";
import { maybeLoadShellEnvForGenerationProviders } from "./test-support/generation-live-test-helpers.js";
import togetherPlugin from "./together/index.js";
import vydraPlugin from "./vydra/index.js";
import xaiPlugin from "./xai/index.js";

const LIVE = isLiveTestEnabled();
const REQUIRE_PROFILE_KEYS =
  isLiveProfileKeyModeEnabled() || isTruthyEnvValue(process.env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
const describeLive = LIVE ? describe : describe.skip;
const providerFilter = parseCsvFilter(process.env.OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS);
const defaultSkippedProviders = providerFilter
  ? null
  : parseCsvFilter(process.env.OPENCLAW_LIVE_VIDEO_GENERATION_SKIP_PROVIDERS ?? "fal");
const envModelMap = parseProviderModelMap(process.env.OPENCLAW_LIVE_VIDEO_GENERATION_MODELS);
const RUN_FULL_VIDEO_MODES = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES,
);
const LIVE_VIDEO_REQUESTED_DURATION_SECONDS = 1;
const LIVE_VIDEO_OPERATION_TIMEOUT_MS = readPositiveIntegerEnv(
  process.env.OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS,
  180_000,
);
const LIVE_VIDEO_TEST_TIMEOUT_MS =
  (RUN_FULL_VIDEO_MODES ? 3 : 1) * LIVE_VIDEO_OPERATION_TIMEOUT_MS + 30_000;
const LIVE_VIDEO_SMOKE_PROMPT =
  "A one-second low-motion video of a blue cube sliding across a clean studio floor.";

type LiveProviderCase = {
  plugin: Parameters<typeof registerProviderPlugin>[0]["plugin"];
  pluginId: string;
  pluginName: string;
  providerId: string;
};

type LiveGeneratedVideo = GeneratedVideoAsset;

type LiveVideoAttemptStatus =
  | { status: "success"; video: LiveGeneratedVideo }
  | { status: "skip" }
  | { status: "failure" };

const CASES: LiveProviderCase[] = [
  {
    plugin: alibabaPlugin,
    pluginId: "alibaba",
    pluginName: "Alibaba Model Studio Plugin",
    providerId: "alibaba",
  },
  {
    plugin: byteplusPlugin,
    pluginId: "byteplus",
    pluginName: "BytePlus Provider",
    providerId: "byteplus",
  },
  {
    plugin: deepinfraPlugin,
    pluginId: "deepinfra",
    pluginName: "DeepInfra Provider",
    providerId: "deepinfra",
  },
  { plugin: falPlugin, pluginId: "fal", pluginName: "fal Provider", providerId: "fal" },
  { plugin: googlePlugin, pluginId: "google", pluginName: "Google Provider", providerId: "google" },
  {
    plugin: minimaxPlugin,
    pluginId: "minimax",
    pluginName: "MiniMax Provider",
    providerId: "minimax",
  },
  { plugin: openaiPlugin, pluginId: "openai", pluginName: "OpenAI Provider", providerId: "openai" },
  {
    plugin: openrouterPlugin,
    pluginId: "openrouter",
    pluginName: "OpenRouter Provider",
    providerId: "openrouter",
  },
  {
    plugin: pixversePlugin,
    pluginId: "pixverse",
    pluginName: "PixVerse Provider",
    providerId: "pixverse",
  },
  { plugin: qwenPlugin, pluginId: "qwen", pluginName: "Qwen Provider", providerId: "qwen" },
  { plugin: runwayPlugin, pluginId: "runway", pluginName: "Runway Provider", providerId: "runway" },
  {
    plugin: togetherPlugin,
    pluginId: "together",
    pluginName: "Together Provider",
    providerId: "together",
  },
  { plugin: vydraPlugin, pluginId: "vydra", pluginName: "Vydra Provider", providerId: "vydra" },
  { plugin: xaiPlugin, pluginId: "xai", pluginName: "xAI Plugin", providerId: "xai" },
]
  .filter((entry) => (providerFilter ? providerFilter.has(entry.providerId) : true))
  .filter((entry) =>
    defaultSkippedProviders ? !defaultSkippedProviders.has(entry.providerId) : true,
  )
  .toSorted((left, right) => left.providerId.localeCompare(right.providerId));

function readPositiveIntegerEnv(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function withPluginsEnabled(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      enabled: true,
    },
  };
}

function createEditReferencePng(params?: { width?: number; height?: number }): Buffer {
  const width = params?.width ?? 384;
  const height = params?.height ?? 384;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 238, 247, 255, 255);
    }
  }

  const outerInsetX = Math.max(1, Math.floor(width / 8));
  const outerInsetY = Math.max(1, Math.floor(height / 8));
  for (let y = outerInsetY; y < height - outerInsetY; y += 1) {
    for (let x = outerInsetX; x < width - outerInsetX; x += 1) {
      fillPixel(buf, x, y, width, 76, 154, 255, 255);
    }
  }

  const innerInsetX = Math.max(1, Math.floor(width / 4));
  const innerInsetY = Math.max(1, Math.floor(height / 4));
  for (let y = innerInsetY; y < height - innerInsetY; y += 1) {
    for (let x = innerInsetX; x < width - innerInsetX; x += 1) {
      fillPixel(buf, x, y, width, 255, 255, 255, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function resolveProviderModelForLiveTest(providerId: string, modelRef: string): string {
  const parsed = parseVideoGenerationModelRef(modelRef);
  if (parsed && parsed.provider === providerId) {
    return parsed.model;
  }
  return modelRef;
}

function maybeLoadShellEnvForVideoProviders(providerIds: string[]): void {
  maybeLoadShellEnvForGenerationProviders(providerIds);
}

function expectGeneratedVideo(video: GeneratedVideoAsset | undefined): LiveGeneratedVideo {
  if (!video) {
    throw new Error("expected generated video asset");
  }
  expect(video.mimeType.startsWith("video/")).toBe(true);
  if (video?.buffer) {
    expect(video.buffer.byteLength).toBeGreaterThan(1024);
    return video;
  }
  if (!video.url) {
    throw new Error("expected generated video buffer or url");
  }
  expect(video.url).toMatch(/^https?:\/\//u);
  return video;
}

function buildLiveCapabilityOverrides(params: {
  caps: VideoGenerationModeCapabilities | undefined;
  liveResolution: VideoGenerationRequest["resolution"];
  liveSize: string | undefined;
}): Pick<VideoGenerationRequest, "size" | "aspectRatio" | "resolution" | "audio" | "watermark"> {
  const { caps, liveResolution, liveSize } = params;
  return {
    ...(caps?.supportsSize && liveSize ? { size: liveSize } : undefined),
    ...(caps?.supportsAspectRatio ? { aspectRatio: "16:9" } : undefined),
    ...(caps?.supportsResolution ? { resolution: liveResolution } : undefined),
    ...(caps?.supportsAudio ? { audio: false } : undefined),
    ...(caps?.supportsWatermark ? { watermark: false } : undefined),
  };
}

function resolveLiveVideoSkipReason(message: string): string | null {
  if (isAuthErrorMessage(message)) {
    return "auth drift";
  }
  if (isModelNotFoundErrorMessage(message)) {
    return "model drift";
  }
  if (isBillingErrorMessage(message)) {
    return "billing drift";
  }
  if (
    isTimeoutErrorMessage(message) ||
    /did not finish in time/i.test(message) ||
    /last status:\s*in_progress/i.test(message)
  ) {
    return "provider timeout";
  }
  if (/operation was aborted/i.test(message)) {
    return "provider timeout";
  }
  if (isOverloadedErrorMessage(message) || isServerErrorMessage(message)) {
    return "provider outage";
  }
  if (
    /HTTP\s+404/i.test(message) &&
    /Invalid URL/i.test(message) &&
    /\/platform\/video_gen/i.test(message)
  ) {
    return "provider endpoint drift";
  }
  if (/access denied|not authorized|not enabled|permission denied/i.test(message)) {
    return "provider/model drift";
  }
  if (/response missing job details|video generation response malformed/i.test(message)) {
    return "provider endpoint drift";
  }
  if (/blocked by (?:our )?moderation system|content policy|policy violation/i.test(message)) {
    return "provider policy drift";
  }
  return null;
}

describe("resolveLiveVideoSkipReason", () => {
  it("classifies malformed provider video responses as endpoint drift", () => {
    expect(resolveLiveVideoSkipReason("xAI video generation response malformed")).toBe(
      "provider endpoint drift",
    );
  });
});

async function runLiveVideoAttempt(params: {
  authLabel: string;
  attempted: string[];
  failures: string[];
  logPrefix: string;
  mode: VideoGenerationMode;
  provider: VideoGenerationProvider;
  providerId: string;
  providerModel: string;
  request: VideoGenerationRequest;
  skipped: string[];
}): Promise<LiveVideoAttemptStatus> {
  const startedAt = Date.now();
  console.error(`${params.logPrefix} mode=${params.mode} start auth=${params.authLabel}`);
  try {
    const result = await params.provider.generateVideo(params.request);
    expect(result.videos.length).toBeGreaterThan(0);
    const video = expectGeneratedVideo(result.videos[0]);
    params.attempted.push(
      `${params.providerId}:${params.mode}:${params.providerModel} (${params.authLabel})`,
    );
    console.error(
      `${params.logPrefix} mode=${params.mode} done ms=${Date.now() - startedAt} videos=${result.videos.length}`,
    );
    return { status: "success", video };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const skipReason = resolveLiveVideoSkipReason(message);
    if (skipReason) {
      params.skipped.push(
        `${params.providerId}:${params.mode} (${params.authLabel}): ${skipReason}`,
      );
      console.warn(
        `${params.logPrefix} mode=${params.mode} skip reason=${skipReason} error=${message}`,
      );
      return { status: "skip" };
    }
    params.failures.push(`${params.providerId}:${params.mode} (${params.authLabel}): ${message}`);
    console.error(`${params.logPrefix} mode=${params.mode} failed error=${message}`);
    return { status: "failure" };
  }
}

function logLiveVideoSummary(params: {
  attempted: string[];
  failures: string[];
  providerId: string;
  skipped: string[];
}): void {
  console.log(
    `[live:video-generation] provider=${params.providerId} attempted=${params.attempted.join(", ") || "none"} skipped=${params.skipped.join(", ") || "none"} failures=${params.failures.join(" | ") || "none"} shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
  );
}

function isRequestedByProviderFilter(providerId: string, filter: Set<string> | null): boolean {
  return filter?.has(providerId) ?? false;
}

function expectSelectedVideoProvidersPresent(
  selectedCases: readonly LiveProviderCase[],
  activeProviderFilter = providerFilter,
): void {
  if (selectedCases.length === 0 && activeProviderFilter && activeProviderFilter.size > 0) {
    throw new Error(
      `[live:video-generation] requested provider filter matched no video providers: ${[...activeProviderFilter].toSorted((a, b) => a.localeCompare(b)).join(", ")}`,
    );
  }
}

function expectLiveVideoCasePassed(
  params: {
    attempted: string[];
    failures: string[];
    providerId: string;
    skipped: string[];
  },
  activeProviderFilter = providerFilter,
): void {
  logLiveVideoSummary(params);
  if (params.attempted.length === 0) {
    expect(params.failures).toStrictEqual([]);
    if (isRequestedByProviderFilter(params.providerId, activeProviderFilter)) {
      throw new Error(
        `[live:video-generation] requested provider produced no live attempts: ${params.providerId}; skipped=${params.skipped.join(", ") || "none"}`,
      );
    }
    console.warn("[live:video-generation] no live video attempt completed; skipping assertions");
    return;
  }
  expect(params.failures).toStrictEqual([]);
}

function resolveLiveSmokeDurationSeconds(params: {
  provider: Parameters<typeof normalizeVideoGenerationDuration>[0]["provider"];
  model: string;
  inputImageCount?: number;
  inputVideoCount?: number;
}): number {
  return (
    normalizeVideoGenerationDuration({
      provider: params.provider,
      model: params.model,
      durationSeconds: LIVE_VIDEO_REQUESTED_DURATION_SECONDS,
      inputImageCount: params.inputImageCount ?? 0,
      inputVideoCount: params.inputVideoCount ?? 0,
    }) ?? LIVE_VIDEO_REQUESTED_DURATION_SECONDS
  );
}

async function runLiveVideoProviderCase(testCase: LiveProviderCase): Promise<void> {
  const cfg = withPluginsEnabled(getRuntimeConfig());
  const configuredModels = resolveConfiguredLiveVideoModels(cfg);
  const agentDir = resolveDefaultAgentDir(cfg as never);
  const attempted: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  const summaryParams = { attempted, failures, providerId: testCase.providerId, skipped };

  maybeLoadShellEnvForVideoProviders([testCase.providerId]);

  const modelRef =
    envModelMap.get(testCase.providerId) ??
    configuredModels.get(testCase.providerId) ??
    DEFAULT_LIVE_VIDEO_MODELS[testCase.providerId];
  if (!modelRef) {
    skipped.push(`${testCase.providerId}: no model configured`);
    expectLiveVideoCasePassed(summaryParams);
    return;
  }

  const hasLiveKeys = collectProviderApiKeys(testCase.providerId).length > 0;
  const authStore = resolveLiveVideoAuthStore({
    requireProfileKeys: REQUIRE_PROFILE_KEYS,
    hasLiveKeys,
  });
  let authLabel;
  try {
    const auth = await resolveApiKeyForProvider({
      provider: testCase.providerId,
      cfg,
      agentDir,
      store: authStore,
    });
    authLabel = `${auth.source} ${redactLiveApiKey(auth.apiKey)}`;
  } catch {
    skipped.push(`${testCase.providerId}: no usable auth`);
    expectLiveVideoCasePassed(summaryParams);
    return;
  }

  const { videoProviders } = await registerProviderPlugin({
    plugin: testCase.plugin,
    id: testCase.pluginId,
    name: testCase.pluginName,
  });
  const provider = requireRegisteredProvider(videoProviders, testCase.providerId, "video provider");
  const providerModel = resolveProviderModelForLiveTest(testCase.providerId, modelRef);
  const generateCaps = provider.capabilities.generate;
  const imageToVideoCaps = provider.capabilities.imageToVideo;
  const videoToVideoCaps = provider.capabilities.videoToVideo;
  const durationSeconds = resolveLiveSmokeDurationSeconds({
    provider,
    model: providerModel,
  });
  const liveResolution = resolveLiveVideoResolution({
    providerId: testCase.providerId,
    modelRef,
  });
  const liveSize = testCase.providerId === "openai" ? "1280x720" : undefined;
  const logPrefix = `[live:video-generation] provider=${testCase.providerId} model=${providerModel}`;

  const generateAttempt = await runLiveVideoAttempt({
    authLabel,
    attempted,
    failures,
    logPrefix,
    mode: "generate",
    provider,
    providerId: testCase.providerId,
    providerModel,
    request: {
      provider: testCase.providerId,
      model: providerModel,
      prompt: LIVE_VIDEO_SMOKE_PROMPT,
      cfg,
      agentDir,
      authStore,
      timeoutMs: LIVE_VIDEO_OPERATION_TIMEOUT_MS,
      durationSeconds,
      ...buildLiveCapabilityOverrides({ caps: generateCaps, liveResolution, liveSize }),
    },
    skipped,
  });
  if (generateAttempt.status === "skip" || generateAttempt.status === "failure") {
    expectLiveVideoCasePassed(summaryParams);
    return;
  }
  const generatedVideo = generateAttempt.video;

  if (!RUN_FULL_VIDEO_MODES) {
    expectLiveVideoCasePassed(summaryParams);
    return;
  }

  if (!imageToVideoCaps?.enabled) {
    expectLiveVideoCasePassed(summaryParams);
    return;
  }
  if (
    !canRunBufferBackedImageToVideoLiveLane({
      providerId: testCase.providerId,
      modelRef,
    })
  ) {
    skipped.push(`${testCase.providerId}:imageToVideo requires remote URL or model-specific input`);
    expectLiveVideoCasePassed(summaryParams);
    return;
  }

  const referenceImage =
    testCase.providerId === "openai"
      ? createEditReferencePng({ width: 1280, height: 720 })
      : createEditReferencePng();
  const imageAttempt = await runLiveVideoAttempt({
    authLabel,
    attempted,
    failures,
    logPrefix,
    mode: "imageToVideo",
    provider,
    providerId: testCase.providerId,
    providerModel,
    request: {
      provider: testCase.providerId,
      model: providerModel,
      prompt: "Animate the reference art with subtle parallax motion and drifting camera movement.",
      cfg,
      agentDir,
      authStore,
      timeoutMs: LIVE_VIDEO_OPERATION_TIMEOUT_MS,
      durationSeconds: resolveLiveSmokeDurationSeconds({
        provider,
        model: providerModel,
        inputImageCount: 1,
      }),
      inputImages: [
        {
          buffer: referenceImage,
          mimeType: "image/png",
          fileName: "reference.png",
        },
      ],
      ...buildLiveCapabilityOverrides({
        caps: imageToVideoCaps,
        liveResolution,
        liveSize,
      }),
    },
    skipped,
  });
  if (imageAttempt.status === "skip" || imageAttempt.status === "failure") {
    expectLiveVideoCasePassed(summaryParams);
    return;
  }

  if (!videoToVideoCaps?.enabled) {
    expectLiveVideoCasePassed(summaryParams);
    return;
  }
  if (
    !canRunBufferBackedVideoToVideoLiveLane({
      providerId: testCase.providerId,
      modelRef,
    })
  ) {
    skipped.push(`${testCase.providerId}:videoToVideo requires remote URL or model-specific input`);
    expectLiveVideoCasePassed(summaryParams);
    return;
  }
  if (!generatedVideo?.buffer) {
    skipped.push(`${testCase.providerId}:videoToVideo missing buffer-backed generated seed video`);
    expectLiveVideoCasePassed(summaryParams);
    return;
  }

  const videoAttempt = await runLiveVideoAttempt({
    authLabel,
    attempted,
    failures,
    logPrefix,
    mode: "videoToVideo",
    provider,
    providerId: testCase.providerId,
    providerModel,
    request: {
      provider: testCase.providerId,
      model: providerModel,
      prompt: "Rework the reference clip into a brighter, steadier cinematic continuation.",
      cfg,
      agentDir,
      authStore,
      timeoutMs: LIVE_VIDEO_OPERATION_TIMEOUT_MS,
      durationSeconds: resolveLiveSmokeDurationSeconds({
        provider,
        model: providerModel,
        inputVideoCount: 1,
      }),
      inputVideos: [generatedVideo],
      ...buildLiveCapabilityOverrides({
        caps: videoToVideoCaps,
        liveResolution,
        liveSize: undefined,
      }),
    },
    skipped,
  });
  if (videoAttempt.status === "skip" || videoAttempt.status === "failure") {
    expectLiveVideoCasePassed(summaryParams);
    return;
  }

  expectLiveVideoCasePassed(summaryParams);
}

describeLive("video generation provider live", () => {
  if (CASES.length === 0) {
    it("skips only unfiltered runs when no video generation providers are selected", () => {
      expectSelectedVideoProvidersPresent(CASES);
      expect(CASES).toHaveLength(0);
    });
  }

  for (const testCase of CASES) {
    // One provider per test keeps cumulative suite runtime from tripping a single timeout cap.
    it(
      `covers declared video-generation modes with shell/profile auth (${testCase.providerId})`,
      async () => {
        await runLiveVideoProviderCase(testCase);
      },
      LIVE_VIDEO_TEST_TIMEOUT_MS,
    );
  }
});

describe("video generation live provider filter coverage", () => {
  it("fails filtered suites when the filter matches no providers", () => {
    expect(() => expectSelectedVideoProvidersPresent([], new Set(["missing"]))).toThrow(
      /requested provider filter matched no video providers: missing/u,
    );
  });

  it("keeps unfiltered zero-attempt provider cases advisory", () => {
    expectLiveVideoCasePassed({
      attempted: [],
      failures: [],
      providerId: "local-only",
      skipped: ["local-only: no usable auth"],
    });
  });

  it("fails filtered provider cases when the requested provider is not attempted", () => {
    expect(() =>
      expectLiveVideoCasePassed(
        {
          attempted: [],
          failures: [],
          providerId: "minimax",
          skipped: ["minimax: no usable auth"],
        },
        new Set(["minimax"]),
      ),
    ).toThrow(/requested provider produced no live attempts: minimax/u);
  });
});
