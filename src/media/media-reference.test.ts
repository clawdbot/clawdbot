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

describe("media reference helpers", () => {
  it("normalizes outbound MEDIA tags without changing canonical media URIs", () => {
    expect(normalizeMediaReferenceSource("  MEDIA: ./out.png")).toBe("./out.png");
    expect(normalizeMediaReferenceSource("media://inbound/a.png")).toBe("media://inbound/a.png");
  });

  it("classifies supported and unsupported media reference schemes", () => {
    expect(classifyMediaReferenceSource("media://inbound/a.png")).toMatchObject({
      isMediaStoreUrl: true,
      hasUnsupportedScheme: false,
    });
    expect(classifyMediaReferenceSource("data:image/png;base64,cG5n")).toMatchObject({
      isDataUrl: true,
      hasUnsupportedScheme: false,
    });
    expect(
      classifyMediaReferenceSource("data:image/png;base64,cG5n", { allowDataUrl: false }),
    ).toMatchObject({
      isDataUrl: true,
      hasUnsupportedScheme: true,
    });
    expect(classifyMediaReferenceSource("ftp://example.test/a.png")).toMatchObject({
      hasUnsupportedScheme: true,
    });
    expect(classifyMediaReferenceSource("C:\\Users\\pete\\image.png")).toMatchObject({
      looksLikeWindowsDrivePath: true,
      hasUnsupportedScheme: false,
    });
  });

  it("resolves canonical inbound media URIs", async () => {
    const stateDir = resolveStateDir();
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(resolveInboundMediaReference(`media://inbound/${id}`)).resolves.toMatchObject({
        id,
        normalizedSource: `media://inbound/${id}`,
        physicalPath: filePath,
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

    try {
      await expect(resolveMediaReferenceLocalPath(`media://inbound/${id}`)).resolves.toBe(filePath);
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

    try {
      await expect(resolveInboundMediaReference(filePath)).resolves.toMatchObject({
        id,
        physicalPath: filePath,
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
    await expect(resolveInboundMediaReference("media://outbound/a.png")).rejects.toMatchObject({
      code: "path-not-allowed",
    });
    await expect(
      resolveInboundMediaReference("media://inbound/nested%2Fa.png"),
    ).rejects.toBeInstanceOf(MediaReferenceError);
    await expect(
      resolveInboundMediaReference("media://inbound/nested%2Fa.png"),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(resolveInboundMediaReference("media://inbound/")).rejects.toMatchObject({
      code: "invalid-path",
    });
    await expect(resolveInboundMediaReference("media://inbound/%00.png")).rejects.toMatchObject({
      code: "invalid-path",
    });
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
      await expect(resolveInboundMediaReference(`media://inbound/${id}`)).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(resolveInboundMediaReference(linkPath)).rejects.toMatchObject({
        code: "invalid-path",
      });
    } finally {
      await fs.rm(linkPath, { force: true });
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
