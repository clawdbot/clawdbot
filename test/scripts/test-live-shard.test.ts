import fs, { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_TEST_SHARDS,
  RELEASE_LIVE_TEST_SHARDS,
  collectAllLiveTestFiles,
  selectLiveShardFiles,
} from "../../scripts/test-live-shard.mjs";

describe("scripts/test-live-shard", () => {
  const allFiles = collectAllLiveTestFiles();

  it("discovers live tests without scanning source roots in-process", () => {
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      const files = collectAllLiveTestFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.endsWith(".live.test.ts"))).toBe(true);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
  });

  it("covers every native live test and tracks provider-filtered release fanout", () => {
    const selected = RELEASE_LIVE_TEST_SHARDS.flatMap((shard) =>
      selectLiveShardFiles(shard, allFiles).map((file) => ({ file, shard })),
    );
    const selectedFiles = selected.map(({ file }) => file);
    const duplicateFiles = selectedFiles.filter(
      (file, index) => selectedFiles.indexOf(file) !== index,
    );
    const musicProviderFanout = selected
      .filter(({ file }) => file === "extensions/music-generation-providers.live.test.ts")
      .map(({ shard }) => shard)
      .toSorted();

    expect(allFiles.length).toBeGreaterThan(0);
    expect([...new Set(selectedFiles)].toSorted((a, b) => a.localeCompare(b))).toEqual(allFiles);
    expect(duplicateFiles).toEqual(["extensions/music-generation-providers.live.test.ts"]);
    expect(musicProviderFanout).toEqual([
      "native-live-extensions-media-music-google",
      "native-live-extensions-media-music-minimax",
    ]);
  });

  it("keeps aggregate shard aliases available outside the release partition", () => {
    expect(LIVE_TEST_SHARDS).toEqual([
      ...RELEASE_LIVE_TEST_SHARDS,
      "native-live-extensions-o-z",
      "native-live-extensions-media",
      "native-live-extensions-media-music",
    ]);

    const oToZAlias = selectLiveShardFiles("native-live-extensions-o-z", allFiles);
    expect(oToZAlias).toEqual(
      [
        ...selectLiveShardFiles("native-live-extensions-o-z-other", allFiles),
        ...selectLiveShardFiles("native-live-extensions-xai", allFiles),
      ].toSorted((a, b) => a.localeCompare(b)),
    );

    const mediaAlias = selectLiveShardFiles("native-live-extensions-media", allFiles);
    expect(mediaAlias).toEqual(
      [
        ...selectLiveShardFiles("native-live-extensions-media-audio", allFiles),
        ...selectLiveShardFiles("native-live-extensions-media-music", allFiles),
        ...selectLiveShardFiles("native-live-extensions-media-video", allFiles),
      ].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("keeps slow gateway backend and media-capable extension files in their own shards", () => {
    expect(selectLiveShardFiles("native-live-src-gateway-backends", allFiles)).toEqual([
      "src/gateway/gateway-acp-bind.live.test.ts",
      "src/gateway/gateway-cli-backend.live.test.ts",
      "src/gateway/gateway-codex-bind.live.test.ts",
      "src/gateway/gateway-codex-harness.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-src-gateway-core", allFiles)).toEqual([
      "src/crestodian/rescue-channel.live.test.ts",
      "src/gateway/android-node.capabilities.live.test.ts",
      "src/gateway/gateway-trajectory-export.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-src-infra", allFiles)).toEqual([
      "src/infra/push-apns-http2.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-test", allFiles)).toEqual([
      "test/image-generation.infer-cli.live.test.ts",
      "test/image-generation.runtime.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-media", allFiles)).toEqual([
      "extensions/minimax/minimax.live.test.ts",
      "extensions/music-generation-providers.live.test.ts",
      "extensions/openai/openai-tts.live.test.ts",
      "extensions/video-generation-providers.live.test.ts",
      "extensions/volcengine/tts.live.test.ts",
      "extensions/vydra/vydra.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-openai", allFiles)).toEqual([
      "extensions/openai/openai-provider.live.test.ts",
      "extensions/openai/openai.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-l-n", allFiles)).toEqual([
      "extensions/memory-lancedb/memory-lancedb.live.test.ts",
      "extensions/microsoft/microsoft.live.test.ts",
      "extensions/mistral/mistral.live.test.ts",
    ]);
    expect(selectLiveShardFiles("native-live-extensions-moonshot", allFiles)).toEqual([
      "extensions/moonshot/moonshot.live.test.ts",
    ]);
  });

  it("keeps the Codex CLI backend live smoke on a minimal tool profile", () => {
    const source = readFileSync("src/gateway/gateway-cli-backend.live.test.ts", "utf8");

    expect(source).toContain('providerId === "codex-cli" && !schemaProbePluginPath');
    expect(source).toContain('profile: "minimal" as const');
  });

  it("rejects unknown shard names", () => {
    expect(() => selectLiveShardFiles("native-live-missing")).toThrow(/Unknown live test shard/u);
  });
});
