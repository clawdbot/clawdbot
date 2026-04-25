import { beforeEach, describe, expect, it, vi } from "vitest";

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
    ).resolves.toMatchObject({ text: "pdf text", extractor: "pdf" });

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

    await expect(
      extractDocumentContent({
        buffer: Buffer.from("pdf"),
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 10,
      }),
    ).rejects.toMatchObject({
      message: "Document extraction failed for application/pdf",
      cause,
    });
  });
});
