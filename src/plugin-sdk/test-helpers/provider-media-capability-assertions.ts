import { expect } from "vitest";
import { listSupportedMusicGenerationModes } from "../../music-generation/capabilities.js";
import type { MusicGenerationProviderPlugin } from "../../plugins/types.js";
import type { VideoGenerationProviderPlugin } from "../../plugins/types.js";
import { listSupportedVideoGenerationModes } from "../../video-generation/capabilities.js";

function hasPositiveModeLimit(
  value: number | undefined,
  valuesByModel: Readonly<Record<string, number>> | undefined,
): boolean {
  return (
    (value ?? 0) > 0 ||
    Object.values(valuesByModel ?? {}).some(
      (modelValue) => Number.isFinite(modelValue) && modelValue > 0,
    )
  );
}

export function expectExplicitVideoGenerationCapabilities(
  provider: VideoGenerationProviderPlugin,
): void {
  expect(
    provider.capabilities.generate,
    `${provider.id} missing generate capabilities`,
  ).toBeDefined();
  expect(
    provider.capabilities.imageToVideo,
    `${provider.id} missing imageToVideo capabilities`,
  ).toBeDefined();
  expect(
    provider.capabilities.videoToVideo,
    `${provider.id} missing videoToVideo capabilities`,
  ).toBeDefined();

  const supportedModes = listSupportedVideoGenerationModes(provider);
  const imageToVideo = provider.capabilities.imageToVideo;
  const videoToVideo = provider.capabilities.videoToVideo;

  if (imageToVideo?.enabled) {
    expect(
      hasPositiveModeLimit(imageToVideo.maxInputImages, imageToVideo.maxInputImagesByModel),
      `${provider.id} imageToVideo.enabled requires maxInputImages or maxInputImagesByModel`,
    ).toBe(true);
    expect(supportedModes).toContain("imageToVideo");
  }
  if (videoToVideo?.enabled) {
    expect(
      hasPositiveModeLimit(videoToVideo.maxInputVideos, videoToVideo.maxInputVideosByModel),
      `${provider.id} videoToVideo.enabled requires maxInputVideos or maxInputVideosByModel`,
    ).toBe(true);
    expect(supportedModes).toContain("videoToVideo");
  }
}

export function expectExplicitMusicGenerationCapabilities(
  provider: MusicGenerationProviderPlugin,
): void {
  expect(
    provider.capabilities.generate,
    `${provider.id} missing generate capabilities`,
  ).toBeDefined();
  expect(provider.capabilities.edit, `${provider.id} missing edit capabilities`).toBeDefined();

  const edit = provider.capabilities.edit;
  if (!edit) {
    return;
  }

  if (edit.enabled) {
    expect(
      edit.maxInputImages ?? 0,
      `${provider.id} edit.enabled requires maxInputImages`,
    ).toBeGreaterThan(0);
    expect(listSupportedMusicGenerationModes(provider)).toContain("edit");
  } else {
    expect(listSupportedMusicGenerationModes(provider)).toEqual(["generate"]);
  }
}
