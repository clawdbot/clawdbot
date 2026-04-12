import { expect } from "vitest";
import { listSupportedMusicGenerationModes } from "../../../src/music-generation/capabilities.js";
import type {
  MusicGenerationProviderPlugin,
  VideoGenerationProviderPlugin,
} from "../../../src/plugins/types.js";
import { listSupportedVideoGenerationModes } from "../../../src/video-generation/capabilities.js";

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
      imageToVideo.maxInputImages ?? 0,
      `${provider.id} imageToVideo.enabled requires maxInputImages`,
    ).toBeGreaterThan(0);
    expect(supportedModes).toContain("imageToVideo");
  }
  if (videoToVideo?.enabled) {
    expect(
      videoToVideo.maxInputVideos ?? 0,
      `${provider.id} videoToVideo.enabled requires maxInputVideos`,
    ).toBeGreaterThan(0);
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
