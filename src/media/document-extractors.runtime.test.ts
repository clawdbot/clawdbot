// Document extractor runtime tests cover lazy document extraction adapters.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const { resolvePluginDocumentExtractorsMock } = vi.hoisted(() => ({
  resolvePluginDocumentExtractorsMock: vi.fn(),
}));

vi.mock("../plugins/document-extractors.runtime.js", () => ({
  resolvePluginDocumentExtractors: resolvePluginDocumentExtractorsMock,
}));

import { extractDocumentContent } from "./document-extractors.runtime.js";

describe("extractDocumentContent", () => {
  beforeEach(() => {
    resolvePluginDocumentExtractorsMock.mockReset();
  });

  it("passes only public extraction request fields to plugins", async () => {
    const extract = vi.fn().mockResolvedValue({ text: "pdf text", images: [] });
    resolvePluginDocumentExtractorsMock.mockReturnValue([
      {
        id: "pdf",
        pluginId: "document-extract",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract,
      },
    ]);

    await expect(
      extractDocumentContent({
        buffer: Buffer.from("pdf"),
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 10,
        config: {
          env: {
            vars: {
              SECRET_VALUE: "do-not-pass",
            },
          },
        },
      }),
    ).resolves.toStrictEqual({ text: "pdf text", images: [], extractor: "pdf" });

    expect(extract).toHaveBeenCalledWith({
      buffer: Buffer.from("pdf"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 100,
      minTextChars: 10,
    });
  });

  it("surfaces matching extractor failures instead of reporting disablement", async () => {
    const cause = new Error("password required");
    resolvePluginDocumentExtractorsMock.mockReturnValue([
      {
        id: "pdf",
        pluginId: "document-extract",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract: vi.fn().mockRejectedValue(cause),
      },
    ]);

    let extractionError: unknown;
    try {
      await extractDocumentContent({
        buffer: Buffer.from("pdf"),
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 10,
      });
    } catch (error) {
      extractionError = error;
    }
    expect(extractionError).toBeInstanceOf(Error);
    if (!(extractionError instanceof Error)) {
      throw new Error("expected extraction error");
    }
    expect(extractionError.message).toBe("Document extraction failed for application/pdf");
    expect(extractionError.cause).toBe(cause);
  });

  it("replaces cached document extractor callbacks when plugin metadata changes", async () => {
    const oldExtract = vi.fn().mockResolvedValue({ text: "retired", images: [] });
    const newExtract = vi.fn().mockResolvedValue({ text: "replacement", images: [] });
    const config = {};
    const createExtractor = (extract: typeof oldExtract) => ({
      id: "pdf",
      pluginId: "document-extract",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      extract,
    });
    resolvePluginDocumentExtractorsMock
      .mockReturnValueOnce([createExtractor(oldExtract)])
      .mockReturnValueOnce([createExtractor(newExtract)]);
    const request = {
      buffer: Buffer.from("pdf"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 100,
      minTextChars: 10,
      config,
    };

    await expect(extractDocumentContent(request)).resolves.toMatchObject({ text: "retired" });

    clearPluginMetadataLifecycleCaches();

    await expect(extractDocumentContent(request)).resolves.toMatchObject({ text: "replacement" });
    expect(resolvePluginDocumentExtractorsMock).toHaveBeenCalledTimes(2);
    expect(oldExtract).toHaveBeenCalledOnce();
    expect(newExtract).toHaveBeenCalledOnce();
  });
});
