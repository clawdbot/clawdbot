import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import {
  classifyMediaReferenceSource,
  MediaReferenceError,
  normalizeMediaReferenceSource,
  resolveInboundMediaReference,
  resolveMediaReferenceLocalPath,
} from "./media-reference.js";

async function expectMediaReferenceError(
  run: () => Promise<unknown>,
  expectedCode: MediaReferenceError["code"],
) {
  let mediaError: unknown;
  try {
    await run();
  } catch (error) {
    mediaError = error;
  }
  expect(mediaError).toBeInstanceOf(MediaReferenceError);
  if (!(mediaError instanceof MediaReferenceError)) {
    throw new Error("expected MediaReferenceError");
  }
  expect(mediaError.name).toBe("MediaReferenceError");
  expect(mediaError.code).toBe(expectedCode);
}

describe("media reference helpers", () => {
  it("normalizes outbound MEDIA tags without changing canonical media URIs", () => {
    expect(normalizeMediaReferenceSource("  MEDIA: ./out.png")).toBe("./out.png");
    expect(normalizeMediaReferenceSource("media://inbound/a.png")).toBe("media://inbound/a.png");
  });

  it("classifies supported and unsupported media reference schemes", () => {
    expect(classifyMediaReferenceSource("media://inbound/a.png")).toStrictEqual({
      hasScheme: true,
      hasUnsupportedScheme: false,
      isDataUrl: false,
      isFileUrl: false,
      isHttpUrl: false,
      isMediaStoreUrl: true,
      looksLikeWindowsDrivePath: false,
    });
    expect(classifyMediaReferenceSource("data:image/png;base64,cG5n")).toStrictEqual({
      hasScheme: true,
      hasUnsupportedScheme: false,
      isDataUrl: true,
      isFileUrl: false,
      isHttpUrl: false,
      isMediaStoreUrl: false,
      looksLikeWindowsDrivePath: false,
    });
    expect(
      classifyMediaReferenceSource("data:image/png;base64,cG5n", { allowDataUrl: false }),
    ).toStrictEqual({
      hasScheme: true,
      hasUnsupportedScheme: true,
      isDataUrl: true,
      isFileUrl: false,
      isHttpUrl: false,
      isMediaStoreUrl: false,
      looksLikeWindowsDrivePath: false,
    });
    expect(classifyMediaReferenceSource("ftp://example.test/a.png")).toStrictEqual({
      hasScheme: true,
      hasUnsupportedScheme: true,
      isDataUrl: false,
      isFileUrl: false,
      isHttpUrl: false,
      isMediaStoreUrl: false,
      looksLikeWindowsDrivePath: false,
    });
    expect(classifyMediaReferenceSource("C:\\Users\\pete\\image.png")).toStrictEqual({
      hasScheme: true,
      hasUnsupportedScheme: false,
      isDataUrl: false,
      isFileUrl: false,
      isHttpUrl: false,
      isMediaStoreUrl: false,
      looksLikeWindowsDrivePath: true,
    });
  });

  it("resolves canonical inbound media URIs", async () => {
    const stateDir = resolveStateDir();
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));
    const realFilePath = await fs.realpath(filePath);

    try {
      await expect(resolveInboundMediaReference(`media://inbound/${id}`)).resolves.toStrictEqual({
        id,
        normalizedSource: `media://inbound/${id}`,
        physicalPath: realFilePath,
        sourceType: "uri",
      });
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("maps canonical inbound media URIs to local paths for direct file readers", async () => {
    const stateDir = resolveStateDir();
    const id = `ref-local-path-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));
    const realFilePath = await fs.realpath(filePath);

    try {
      await expect(resolveMediaReferenceLocalPath(`media://inbound/${id}`)).resolves.toBe(
        realFilePath,
      );
      await expect(resolveMediaReferenceLocalPath("  MEDIA: ./out.png")).resolves.toBe("./out.png");
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("resolves direct absolute paths only for first-level inbound media files", async () => {
    const stateDir = resolveStateDir();
    const id = `ref-path-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));
    const realFilePath = await fs.realpath(filePath);

    try {
      await expect(resolveInboundMediaReference(filePath)).resolves.toStrictEqual({
        id,
        normalizedSource: filePath,
        physicalPath: realFilePath,
        sourceType: "path",
      });
      await expect(
        resolveInboundMediaReference(path.join(stateDir, "media", "inbound", "nested", id)),
      ).resolves.toBeNull();
      await expect(
        resolveInboundMediaReference(path.join(stateDir, "media", "outbound", id)),
      ).resolves.toBeNull();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("rejects inbound media URIs with unsupported locations or unsafe ids", async () => {
    await expectMediaReferenceError(
      () => resolveInboundMediaReference("media://outbound/a.png"),
      "path-not-allowed",
    );
    await expectMediaReferenceError(
      () => resolveInboundMediaReference("media://inbound/nested%2Fa.png"),
      "invalid-path",
    );
    await expectMediaReferenceError(
      () => resolveInboundMediaReference("media://inbound/"),
      "invalid-path",
    );
    await expectMediaReferenceError(
      () => resolveInboundMediaReference("media://inbound/%00.png"),
      "invalid-path",
    );
  });

  it("rejects symlinked inbound media files", async () => {
    const stateDir = resolveStateDir();
    const targetDir = path.join(stateDir, "media-reference-test-target");
    const targetPath = path.join(targetDir, "target.png");
    const id = `ref-link-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const linkPath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.writeFile(targetPath, Buffer.from("png"));
    await fs.symlink(targetPath, linkPath);

    try {
      await expectMediaReferenceError(
        () => resolveInboundMediaReference(`media://inbound/${id}`),
        "invalid-path",
      );
      await expectMediaReferenceError(() => resolveInboundMediaReference(linkPath), "invalid-path");
    } finally {
      await fs.rm(linkPath, { force: true });
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
