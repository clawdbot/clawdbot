import { describe, expect, it, vi } from "vitest";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";

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

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: vi.fn(() => ({
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
  resolveManifestContractOwnerPluginId: vi.fn(() => undefined),
}));

describe("resolvePluginDocumentExtractors", () => {
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
