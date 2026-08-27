/** Protects plugin-owned web extractor dispatch, caching, fallbacks, and lifecycle changes. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const { resolvePluginWebContentExtractorsMock } = vi.hoisted(() => ({
  resolvePluginWebContentExtractorsMock: vi.fn(),
}));

vi.mock("../plugins/web-content-extractors.runtime.js", () => ({
  resolvePluginWebContentExtractors: resolvePluginWebContentExtractorsMock,
}));

import { extractReadableContent } from "./content-extractors.runtime.js";

describe("extractReadableContent", () => {
  beforeEach(() => {
    resolvePluginWebContentExtractorsMock.mockReset();
  });

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

  it("dispatches to enabled web content extractors", async () => {
    resolvePluginWebContentExtractorsMock.mockReturnValue([
      {
        id: "readability",
        pluginId: "web-readability",
        label: "Readability",
        extract: vi.fn().mockResolvedValue({
          text: "extracted text",
          title: "Extracted",
        }),
      },
    ]);

    const result = await extractReadableContent({
      html: "<article><p>raw html</p></article>",
      url: "https://example.com/article",
      extractMode: "text",
      config: {},
    });
    expect(result?.extractor).toBe("readability");
    expect(result?.text).toBe("extracted text");
    expect(result?.title).toBe("Extracted");
  });

  it("reuses extractor resolution for repeated calls with the same config object", async () => {
    // Extractor manifests are process-stable for a config snapshot; repeated
    // reads should not re-run plugin discovery on the fetch hot path.
    const config = {};
    resolvePluginWebContentExtractorsMock.mockReturnValue([
      {
        id: "readability",
        pluginId: "web-readability",
        label: "Readability",
        extract: vi.fn().mockResolvedValue({
          text: "cached resolver text",
        }),
      },
    ]);

    await extractReadableContent({
      html: "<article><p>first</p></article>",
      url: "https://example.com/first",
      extractMode: "text",
      config,
    });
    await extractReadableContent({
      html: "<article><p>second</p></article>",
      url: "https://example.com/second",
      extractMode: "text",
      config,
    });

    expect(resolvePluginWebContentExtractorsMock).toHaveBeenCalledTimes(1);
    expect(resolvePluginWebContentExtractorsMock).toHaveBeenCalledWith({ config });
  });

  it("returns null when no extractor produces content", async () => {
    resolvePluginWebContentExtractorsMock.mockReturnValue([
      {
        id: "readability",
        pluginId: "web-readability",
        label: "Readability",
        extract: vi.fn().mockResolvedValue(null),
      },
    ]);

    const result = await extractReadableContent({
      html: "<article><p>Main content starts here with enough words to satisfy readability.</p><p>Second paragraph for signal.</p></article>",
      url: "https://example.com/article",
      extractMode: "text",
      config: {},
    });
    expect(result).toBeNull();
  });

  it("continues when a plugin extractor throws", async () => {
    resolvePluginWebContentExtractorsMock.mockReturnValue([
      {
        id: "broken",
        pluginId: "broken-plugin",
        label: "Broken",
        extract: vi.fn().mockRejectedValue(new Error("boom")),
      },
      {
        id: "readability",
        pluginId: "web-readability",
        label: "Readability",
        extract: vi.fn().mockResolvedValue({
          text: "fallback text",
        }),
      },
    ]);

    const result = await extractReadableContent({
      html: "<article><p>raw html</p></article>",
      url: "https://example.com/article",
      extractMode: "text",
      config: {},
    });
    expect(result?.extractor).toBe("readability");
    expect(result?.text).toBe("fallback text");
  });

  it("returns null when extractor loading throws", async () => {
    resolvePluginWebContentExtractorsMock.mockImplementation(() => {
      throw new Error("loader boom");
    });

    await expect(
      extractReadableContent({
        html: "<article><p>raw html</p></article>",
        url: "https://example.com/article",
        extractMode: "text",
        config: {},
      }),
    ).resolves.toBeNull();
  });
});
