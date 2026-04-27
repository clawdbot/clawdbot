import { describe, expect, it, vi } from "vitest";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

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

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: vi.fn(() => ({
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

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  loadPluginManifestRegistryForPluginRegistry: vi.fn(() => ({
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
    vi.mocked(loadPluginManifestRegistryForPluginRegistry).mockClear();

    expect(resolvePluginDocumentExtractors().map((extractor) => extractor.id)).toEqual(["pdf"]);
    expect(loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledOnce();
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
    ).toEqual([]);
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
    ).toEqual([]);
  });
});
