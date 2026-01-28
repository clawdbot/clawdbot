import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { detectMime, extensionForMime, imageMimeFromFormat } from "./mime.js";

async function makeOoxmlZip(opts: { mainMime: string; partPath: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types><Override PartName="${opts.partPath}" ContentType="${opts.mainMime}.main+xml"/></Types>`,
  );
  zip.file(opts.partPath.slice(1), "<xml/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("mime detection", () => {
  it("maps common image formats to mime types", () => {
    expect(imageMimeFromFormat("jpg")).toBe("image/jpeg");
    expect(imageMimeFromFormat("jpeg")).toBe("image/jpeg");
    expect(imageMimeFromFormat("png")).toBe("image/png");
    expect(imageMimeFromFormat("webp")).toBe("image/webp");
    expect(imageMimeFromFormat("gif")).toBe("image/gif");
    expect(imageMimeFromFormat("unknown")).toBeUndefined();
  });

  it("detects docx from buffer", async () => {
    const buf = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      partPath: "/word/document.xml",
    });
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/file.bin" });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("detects pptx from buffer", async () => {
    const buf = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      partPath: "/ppt/presentation.xml",
    });
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/file.bin" });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  it("prefers extension mapping over generic zip", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const buf = await zip.generateAsync({ type: "nodebuffer" });

    const mime = await detectMime({
      buffer: buf,
      filePath: "/tmp/file.xlsx",
    });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});

describe("extensionForMime", () => {
  it("maps image MIME types to extensions", () => {
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/webp")).toBe(".webp");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/heic")).toBe(".heic");
  });

  it("maps audio MIME types to extensions", () => {
    expect(extensionForMime("audio/mpeg")).toBe(".mp3");
    expect(extensionForMime("audio/ogg")).toBe(".ogg");
    expect(extensionForMime("audio/x-m4a")).toBe(".m4a");
    expect(extensionForMime("audio/mp4")).toBe(".m4a");
  });

  it("maps video MIME types to extensions", () => {
    expect(extensionForMime("video/mp4")).toBe(".mp4");
    expect(extensionForMime("video/quicktime")).toBe(".mov");
  });

  it("maps document MIME types to extensions", () => {
    expect(extensionForMime("application/pdf")).toBe(".pdf");
    expect(extensionForMime("text/plain")).toBe(".txt");
    expect(extensionForMime("text/markdown")).toBe(".md");
  });

  it("handles case insensitivity", () => {
    expect(extensionForMime("IMAGE/JPEG")).toBe(".jpg");
    expect(extensionForMime("Audio/X-M4A")).toBe(".m4a");
    expect(extensionForMime("Video/QuickTime")).toBe(".mov");
  });

  it("returns undefined for unknown MIME types", () => {
    expect(extensionForMime("video/unknown")).toBeUndefined();
    expect(extensionForMime("application/x-custom")).toBeUndefined();
  });

  it("returns undefined for null or undefined input", () => {
    expect(extensionForMime(null)).toBeUndefined();
    expect(extensionForMime(undefined)).toBeUndefined();
  });
});
