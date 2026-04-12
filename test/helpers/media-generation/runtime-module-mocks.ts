import { vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { ImageGenerationProvider } from "../../../src/image-generation/types.js";
import type { MusicGenerationProvider } from "../../../src/music-generation/types.js";
import type { VideoGenerationProvider } from "../../../src/video-generation/types.js";
import { resetGenerationRuntimeMocks } from "./runtime-test-mocks.js";

type ModelRef = { provider: string; model: string };

const mediaRuntimeMocks = vi.hoisted(() => {
  const debug = vi.fn();
  const warn = vi.fn();
  const parseGenerationModelRef = (raw?: string): ModelRef | undefined => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return undefined;
    }
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      return undefined;
    }
    return {
      provider: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1),
    };
  };
  return {
    createSubsystemLogger: vi.fn(() => ({ debug, warn: vi.fn() })),
    describeFailoverError: vi.fn(),
    getImageGenerationProvider: vi.fn<
      (providerId: string, config?: OpenClawConfig) => ImageGenerationProvider | undefined
    >(() => undefined),
    getMusicGenerationProvider: vi.fn<
      (providerId: string, config?: OpenClawConfig) => MusicGenerationProvider | undefined
    >(() => undefined),
    getProviderEnvVars: vi.fn<(providerId: string) => string[]>(() => []),
    getVideoGenerationProvider: vi.fn<
      (providerId: string, config?: OpenClawConfig) => VideoGenerationProvider | undefined
    >(() => undefined),
    isFailoverError: vi.fn<(err: unknown) => boolean>(() => false),
    listImageGenerationProviders: vi.fn<(config?: OpenClawConfig) => ImageGenerationProvider[]>(
      () => [],
    ),
    listMusicGenerationProviders: vi.fn<(config?: OpenClawConfig) => MusicGenerationProvider[]>(
      () => [],
    ),
    listVideoGenerationProviders: vi.fn<(config?: OpenClawConfig) => VideoGenerationProvider[]>(
      () => [],
    ),
    parseImageGenerationModelRef:
      vi.fn<(raw?: string) => ModelRef | undefined>(parseGenerationModelRef),
    parseMusicGenerationModelRef:
      vi.fn<(raw?: string) => ModelRef | undefined>(parseGenerationModelRef),
    parseVideoGenerationModelRef:
      vi.fn<(raw?: string) => ModelRef | undefined>(parseGenerationModelRef),
    resolveAgentModelFallbackValues: vi.fn<(value: unknown) => string[]>(() => []),
    resolveAgentModelPrimaryValue: vi.fn<(value: unknown) => string | undefined>(() => undefined),
    resolveProviderAuthEnvVarCandidates: vi.fn(() => ({})),
    debug,
    warn,
  };
});

vi.mock("../../../src/agents/failover-error.js", () => ({
  describeFailoverError: mediaRuntimeMocks.describeFailoverError,
  isFailoverError: mediaRuntimeMocks.isFailoverError,
}));
vi.mock("../../../src/config/model-input.js", () => ({
  resolveAgentModelFallbackValues: mediaRuntimeMocks.resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue: mediaRuntimeMocks.resolveAgentModelPrimaryValue,
}));
vi.mock("../../../src/logging/subsystem.js", () => ({
  createSubsystemLogger: mediaRuntimeMocks.createSubsystemLogger,
}));
vi.mock("../../../src/secrets/provider-env-vars.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/secrets/provider-env-vars.js")>();
  return {
    ...actual,
    getProviderEnvVars: mediaRuntimeMocks.getProviderEnvVars,
    resolveProviderAuthEnvVarCandidates: mediaRuntimeMocks.resolveProviderAuthEnvVarCandidates,
  };
});

vi.mock("../../../src/image-generation/model-ref.js", () => ({
  parseImageGenerationModelRef: mediaRuntimeMocks.parseImageGenerationModelRef,
}));
vi.mock("../../../src/image-generation/provider-registry.js", () => ({
  getImageGenerationProvider: mediaRuntimeMocks.getImageGenerationProvider,
  listImageGenerationProviders: mediaRuntimeMocks.listImageGenerationProviders,
}));
vi.mock("../../../src/music-generation/model-ref.js", () => ({
  parseMusicGenerationModelRef: mediaRuntimeMocks.parseMusicGenerationModelRef,
}));
vi.mock("../../../src/music-generation/provider-registry.js", () => ({
  getMusicGenerationProvider: mediaRuntimeMocks.getMusicGenerationProvider,
  listMusicGenerationProviders: mediaRuntimeMocks.listMusicGenerationProviders,
}));
vi.mock("../../../src/video-generation/model-ref.js", () => ({
  parseVideoGenerationModelRef: mediaRuntimeMocks.parseVideoGenerationModelRef,
}));
vi.mock("../../../src/video-generation/provider-registry.js", () => ({
  getVideoGenerationProvider: mediaRuntimeMocks.getVideoGenerationProvider,
  listVideoGenerationProviders: mediaRuntimeMocks.listVideoGenerationProviders,
}));

export function getMediaGenerationRuntimeMocks() {
  return mediaRuntimeMocks;
}

export function resetImageGenerationRuntimeMocks(): void {
  resetGenerationRuntimeMocks({
    ...mediaRuntimeMocks,
    getProvider: mediaRuntimeMocks.getImageGenerationProvider,
    listProviders: mediaRuntimeMocks.listImageGenerationProviders,
    parseModelRef: mediaRuntimeMocks.parseImageGenerationModelRef,
  });
}

export function resetMusicGenerationRuntimeMocks(): void {
  resetGenerationRuntimeMocks({
    ...mediaRuntimeMocks,
    getProvider: mediaRuntimeMocks.getMusicGenerationProvider,
    listProviders: mediaRuntimeMocks.listMusicGenerationProviders,
    parseModelRef: mediaRuntimeMocks.parseMusicGenerationModelRef,
  });
}

export function resetVideoGenerationRuntimeMocks(): void {
  resetGenerationRuntimeMocks({
    ...mediaRuntimeMocks,
    getProvider: mediaRuntimeMocks.getVideoGenerationProvider,
    listProviders: mediaRuntimeMocks.listVideoGenerationProviders,
    parseModelRef: mediaRuntimeMocks.parseVideoGenerationModelRef,
  });
}
