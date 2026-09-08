// Document extractor runtime tests cover lazy document extraction adapters.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import type { resolvePluginDocumentExtractors } from "../plugins/document-extractors.runtime.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const { resolvePluginDocumentExtractorsMock } = vi.hoisted(() => ({
  resolvePluginDocumentExtractorsMock: vi.fn<typeof resolvePluginDocumentExtractors>(),
}));

vi.mock("../plugins/document-extractors.runtime.js", () => ({
  resolvePluginDocumentExtractors: resolvePluginDocumentExtractorsMock,
}));

import { extractDocumentContent } from "./document-extractors.runtime.js";
import { extractPdfContent } from "./pdf-extract.js";

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

  it.each([
    {
      name: "populated optional fields",
      password: "  retained  ",
      pageNumbers: [2, 1],
      callback: true,
    },
    { name: "empty password and pages", password: "", pageNumbers: [], callback: false },
  ])("preserves the composed PDF request with $name", async (row) => {
    const { password, pageNumbers, callback } = row;
    const buffer = Buffer.from("%PDF-1.4");
    const config = {};
    const images: DocumentExtractionResult["images"] = [];
    const imageError = new Error("image rendering failed");
    const onImageExtractionError = vi.fn<(error: unknown) => void>();
    const extract = vi.fn(async (request: DocumentExtractionRequest) => {
      expect(request).toStrictEqual({
        buffer,
        mimeType: "application/pdf",
        maxPages: 2,
        maxPixels: 100,
        minTextChars: 10,
        ...(password ? { password: "  retained  " } : {}),
        pageNumbers,
        ...(callback ? { onImageExtractionError } : {}),
      });
      expect(request.buffer).toBe(buffer);
      expect(request.pageNumbers).toBe(pageNumbers);
      expect(request.onImageExtractionError).toBe(callback ? onImageExtractionError : undefined);
      request.onImageExtractionError?.(imageError);
      return { text: "pdf text", images };
    });
    resolvePluginDocumentExtractorsMock.mockReturnValue([
      {
        id: "pdf",
        pluginId: "document-extract",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract,
      },
    ]);

    const result = await extractPdfContent({
      buffer,
      maxPages: 2,
      maxPixels: 100,
      minTextChars: 10,
      password,
      pageNumbers,
      config,
      onImageExtractionError: callback ? onImageExtractionError : undefined,
    });

    expect(resolvePluginDocumentExtractorsMock).toHaveBeenCalledOnce();
    expect(resolvePluginDocumentExtractorsMock.mock.calls[0]?.[0]?.config).toBe(config);
    expect(extract).toHaveBeenCalledOnce();
    expect(result).toStrictEqual({ text: "pdf text", images });
    expect(result.images).toBe(images);
    if (callback) {
      expect(onImageExtractionError).toHaveBeenCalledOnce();
      expect(onImageExtractionError).toHaveBeenCalledWith(imageError);
    } else {
      expect(onImageExtractionError).not.toHaveBeenCalled();
    }
  });
});
