import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
  resolveDocumentMediaModel,
} from "./defaults.js";

function createMediaSnapshot(generation: string, nativePdf: boolean) {
  return finalizePluginMetadataSnapshot(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "media-owner",
          contracts: { mediaUnderstandingProviders: ["media-owner", "other-owner"] },
          mediaUnderstandingProviderMetadata: {
            "media-owner": {
              capabilities: ["audio", "image"],
              defaultModels: { audio: `${generation}-audio`, image: `${generation}-image` },
              autoPriority: { audio: nativePdf ? 1 : 3 },
              nativeDocumentInputs: nativePdf ? ["pdf"] : [],
              documentModels: { pdf: { textExtraction: `${generation}-text`, image: false } },
            },
            "other-owner": { capabilities: ["audio"], autoPriority: { audio: 2 } },
          },
        },
      ],
    }),
  );
}

describe("media defaults generation ownership", () => {
  it.each([false, true])("follows nested metadata scopes with config=%s", (hasConfig) => {
    const cfg: OpenClawConfig | undefined = hasConfig ? {} : undefined;
    const options = { config: cfg, trustConfigIdentity: true };
    const first = createMediaSnapshot("first", true);
    const second = createMediaSnapshot("second", false);
    const readDefaults = () => ({
      model: resolveDefaultMediaModel({ providerId: "media-owner", capability: "audio", cfg }),
      order: resolveAutoMediaKeyProviders({ capability: "audio", cfg }),
      nativePdf: providerSupportsNativePdfDocument({ providerId: "media-owner", cfg }),
      documentModel: resolveDocumentMediaModel({
        providerId: "media-owner",
        document: "pdf",
        mode: "textExtraction",
        cfg,
      }),
    });
    const firstExpected = {
      model: "first-audio",
      order: ["media-owner", "other-owner"],
      nativePdf: true,
      documentModel: "first-text",
    };

    withPluginMetadataSnapshotScope(
      first,
      () => {
        expect(readDefaults()).toEqual(firstExpected);
        withPluginMetadataSnapshotScope(
          second,
          () => {
            expect(readDefaults()).toEqual({
              model: "second-audio",
              order: ["other-owner", "media-owner"],
              nativePdf: false,
              documentModel: "second-text",
            });
          },
          options,
        );
        expect(readDefaults()).toEqual(firstExpected);
      },
      options,
    );
  });
});
