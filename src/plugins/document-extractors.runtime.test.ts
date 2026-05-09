import { describe, expect, it, vi } from "vitest";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

vi.mock("./document-extractor-public-artifacts.js", () => ({
  loadBundledDocumentExtractorEntriesFromDir: vi.fn(
    ({ dirName }: { dirName: string; pluginId: string }) =>
      dirName === "document-extract"
        ? [
            {
              id: "pdf",
              label: "PDF",
              mimeTypes: ["application/pdf"],
              pluginId: "document-extract",
              extract: vi.fn(),
            },
          ]
        : null,
  ),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: vi.fn(() => ({
    plugins: [
      {
        id: "document-extract",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        cliBackends: [],
        providers: [],
        legacyPluginIds: [],
        contracts: { documentExtractors: ["pdf"] },
      },
      {
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        cliBackends: [],
        providers: ["openai", "openai-codex"],
        legacyPluginIds: [],
        contracts: {},
      },
    ],
  })),
}));

vi.mock("./manifest-registry.js", () => ({
  resolveManifestContractOwnerPluginId: vi.fn(() => undefined),
}));

describe("resolvePluginDocumentExtractors", () => {
  it("reuses one manifest registry pass for compat and enabled bundled extractors", () => {
    vi.mocked(loadPluginMetadataSnapshot).mockClear();

    expect(resolvePluginDocumentExtractors().map((extractor) => extractor.id)).toEqual(["pdf"]);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("respects global plugin disablement", () => {
    expect(
      resolvePluginDocumentExtractors({
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("does not expand an operator plugin allowlist", () => {
    expect(
      resolvePluginDocumentExtractors({
        config: {
          plugins: {
            allow: ["openai"],
          },
        },
      }),
    ).toStrictEqual([]);
  });
});
