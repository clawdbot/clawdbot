import { describe, expect, it } from "vitest";
import {
  generatedImageAssetFromDataUrl,
  imageFileExtensionForMimeType,
  imageSourceUploadFileName,
  parseImageDataUrl,
  parseOpenAiCompatibleImageResponse,
  sniffImageMimeType,
  toImageDataUrl,
} from "./image-assets.js";

describe("image asset helpers", () => {
  it("converts buffers to image data URLs and parses them back", () => {
    const buffer = Buffer.from("png-bytes");
    const dataUrl = toImageDataUrl({ buffer, mimeType: "image/png" });

    expect(dataUrl).toBe(`data:image/png;base64,${buffer.toString("base64")}`);
    expect(parseImageDataUrl(dataUrl)).toEqual({
      mimeType: "image/png",
      base64: buffer.toString("base64"),
    });
    expect(generatedImageAssetFromDataUrl({ dataUrl, index: 1 })).toMatchObject({
      buffer,
      mimeType: "image/png",
      fileName: "image-2.png",
    });
  });

  it("normalizes image file extensions", () => {
    expect(imageFileExtensionForMimeType("image/jpeg")).toBe("jpg");
    expect(imageFileExtensionForMimeType("image/webp")).toBe("webp");
    expect(imageFileExtensionForMimeType("image/svg+xml")).toBe("svg");
    expect(imageFileExtensionForMimeType(undefined, "jpg")).toBe("jpg");
  });

  it("sniffs common generated image types", () => {
    expect(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff]))).toEqual({
      mimeType: "image/jpeg",
      extension: "jpg",
    });
    expect(sniffImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toEqual({
      mimeType: "image/png",
      extension: "png",
    });
  });

  it("parses OpenAI-compatible base64 image responses", () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const images = parseOpenAiCompatibleImageResponse(
      {
        data: [
          {
            b64_json: jpegBytes.toString("base64"),
            revised_prompt: "revised",
          },
          { b64_json: "" },
        ],
      },
      { defaultMimeType: "image/png", sniffMimeType: true },
    );

    expect(images).toEqual([
      {
        buffer: jpegBytes,
        mimeType: "image/jpeg",
        fileName: "image-1.jpg",
        revisedPrompt: "revised",
      },
    ]);
  });

  it("resolves source upload filenames from explicit names or MIME types", () => {
    expect(
      imageSourceUploadFileName({
        image: { buffer: Buffer.from("x"), mimeType: "image/webp" },
        index: 2,
      }),
    ).toBe("image-3.webp");
    expect(
      imageSourceUploadFileName({
        image: { buffer: Buffer.from("x"), mimeType: "image/png", fileName: "source.png" },
        index: 0,
      }),
    ).toBe("source.png");
  });
});
