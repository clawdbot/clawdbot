import { beforeEach, describe, expect, it, vi } from "vitest";

const { publicArtifactModule } = vi.hoisted(() => ({
  publicArtifactModule: {} as Record<string, unknown>,
}));

vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: vi.fn(() => publicArtifactModule),
  resolveBundledPluginPublicArtifactPath: vi.fn(
    () => "/repo/extensions/demo/document-extractor.ts",
  ),
}));

import { loadBundledDocumentExtractorEntriesFromDir } from "./document-extractor-public-artifacts.js";

describe("loadBundledDocumentExtractorEntriesFromDir", () => {
  beforeEach(() => {
    for (const key of Object.keys(publicArtifactModule)) {
      delete publicArtifactModule[key];
    }
  });

  it("isolates a throwing factory when another extractor factory succeeds", () => {
    publicArtifactModule.createBrokenDocumentExtractor = () => {
      throw new Error("native probe failed");
    };
    publicArtifactModule.createPdfDocumentExtractor = () => ({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      extract: vi.fn(),
    });

    expect(
      loadBundledDocumentExtractorEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toMatchObject([{ id: "pdf", pluginId: "demo" }]);
  });

  it("surfaces initialization failure when every matching factory throws", () => {
    const cause = new Error("native probe failed");
    publicArtifactModule.createPdfDocumentExtractor = () => {
      throw cause;
    };

    expect(() =>
      loadBundledDocumentExtractorEntriesFromDir({
        dirName: "demo",
        pluginId: "demo",
      }),
    ).toThrow("Unable to initialize document extractors for plugin demo");
  });
});
