// Media-store ingestion tests cover byte-detected limits for local files and streams.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

describe("media store detected limits", () => {
  let store: typeof import("./store.js");
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-media-ingest-test-home-");
    store = await import("./store.js");
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it("applies a byte-detected source limit instead of the filename hint", async () => {
    const sourcePath = path.join(tempHome.home, "report.png");
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64)]);
    await fs.writeFile(sourcePath, pdf);

    const saved = await store.saveMediaSource(sourcePath, undefined, "outbound", 1024, {
      maxBytesForMime: (mime) => (mime === "application/pdf" ? 1024 : 8),
    });

    expect(saved.contentType).toBe("application/pdf");
    expect(saved.size).toBe(pdf.byteLength);
  });

  it("keeps detected bytes authoritative over declared metadata", async () => {
    const sourcePath = path.join(tempHome.home, "opaque-upload");
    await fs.writeFile(sourcePath, createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 }));

    const saved = await store.saveMediaSource(sourcePath, undefined, "outbound", 1024, {
      contentTypeHint: "text/csv",
      fileNameHint: "report.csv",
    });

    expect(saved.contentType).toBe("image/png");
    expect(saved.id).toMatch(/\.png$/u);
  });

  it("keeps a recognized source extension authoritative over declared metadata", async () => {
    const sourcePath = path.join(tempHome.home, "report.csv");
    await fs.writeFile(sourcePath, "id,label\n1,alpha\n");

    const saved = await store.saveMediaSource(sourcePath, undefined, "outbound", 1024, {
      contentTypeHint: "image/png",
      fileNameHint: "photo.png",
    });

    expect(saved.contentType).toBe("text/csv");
    expect(saved.id).toMatch(/\.csv$/u);
  });

  it.each([
    ["MIME", { contentTypeHint: "text/csv" }],
    ["filename", { fileNameHint: "report.csv" }],
  ] as const)("uses a declared %s hint for opaque local bytes", async (_label, options) => {
    const sourcePath = path.join(tempHome.home, `opaque-${_label.toLowerCase()}`);
    await fs.writeFile(sourcePath, "id,label\n1,alpha\n");

    const saved = await store.saveMediaSource(sourcePath, undefined, "outbound", 1024, options);

    expect(saved.contentType).toBe("text/csv");
    expect(saved.id).toMatch(/\.csv$/u);
  });

  it("does not let declared metadata raise the detected stream limit", async () => {
    await expect(
      store.saveMediaStream(
        Readable.from(["id,label\n1,alpha\n"]),
        undefined,
        "hinted-stream-limit",
        1024,
        undefined,
        undefined,
        {
          contentTypeHint: "image/png",
          fileNameHint: "photo.png",
          maxBytesForMime: (mime) => (mime ? 1024 : 8),
        },
      ),
    ).rejects.toThrow("Media exceeds 0MB limit");
  });

  it("applies a byte-detected limit while streaming", async () => {
    const oversizedPng = Buffer.concat([
      createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 }),
      Buffer.alloc(16_384),
    ]);

    await expect(
      store.saveMediaStream(
        Readable.from([oversizedPng]),
        undefined,
        "detected-oversized-stream",
        32 * 1024,
        "photo.bin",
        undefined,
        { maxBytesForMime: (mime) => (mime === "image/png" ? 1024 : 32 * 1024) },
      ),
    ).rejects.toThrow("Media exceeds 0MB limit");

    const targetDir = path.join(tempHome.home, ".openclaw", "media", "detected-oversized-stream");
    const entries = await fs.readdir(targetDir).catch(() => []);
    expect(entries).toStrictEqual([]);
  });
});
