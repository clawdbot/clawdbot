/** Protects plugin-owned web extractor callbacks across metadata lifecycle changes. */
import { describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const { resolvePluginWebContentExtractorsMock } = vi.hoisted(() => ({
  resolvePluginWebContentExtractorsMock: vi.fn(),
}));

vi.mock("../plugins/web-content-extractors.runtime.js", () => ({
  resolvePluginWebContentExtractors: resolvePluginWebContentExtractorsMock,
}));

import { extractReadableContent } from "./content-extractors.runtime.js";

describe("extractReadableContent", () => {
  it("replaces cached web content extractor callbacks when plugin metadata changes", async () => {
    const oldExtract = vi.fn().mockResolvedValue({ text: "retired" });
    const newExtract = vi.fn().mockResolvedValue({ text: "replacement" });
    const config = {};
    const createExtractor = (extract: typeof oldExtract) => ({
      id: "readable",
      pluginId: "web-content-extract",
      label: "Readable",
      extract,
    });
    resolvePluginWebContentExtractorsMock
      .mockReturnValueOnce([createExtractor(oldExtract)])
      .mockReturnValueOnce([createExtractor(newExtract)]);
    const request = {
      html: "<p>content</p>",
      url: "https://example.test/page",
      extractMode: "text" as const,
      config,
    };

    await expect(extractReadableContent(request)).resolves.toMatchObject({ text: "retired" });

    clearPluginMetadataLifecycleCaches();

    await expect(extractReadableContent(request)).resolves.toMatchObject({ text: "replacement" });
    expect(resolvePluginWebContentExtractorsMock).toHaveBeenCalledTimes(2);
    expect(oldExtract).toHaveBeenCalledOnce();
    expect(newExtract).toHaveBeenCalledOnce();
  });
});
