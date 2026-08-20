import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { loadWebMedia } from "./web-media.js";

const TINY_PNG = createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 });

describe.runIf(process.platform === "win32")("Windows web media file URLs", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-web-media-file-url-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("loads single-slash uppercase file URLs with spaces and Unicode", async () => {
    const filePath = path.join(fixtureRoot, "café image.png");
    await fs.writeFile(filePath, TINY_PNG);
    const fileUrl = pathToFileURL(filePath).href.replace(/^file:\/\//u, "FILE:");

    const result = await loadWebMedia(fileUrl, {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
    });

    expect(result.buffer).toEqual(TINY_PNG);
    expect(result.fileName).toBe("café image.png");
  });

  it.each([
    "FILE://attacker/share/evil.png",
    "FILE:///C:/safe/folder%2Fsecret.png",
    "FILE:///C:/safe/folder%5Csecret.png",
    "FILE:////attacker/share/evil.png",
  ])("rejects unsafe uppercase file URL %s", async (fileUrl) => {
    await expect(loadWebMedia(fileUrl, { localRoots: [fixtureRoot] })).rejects.toMatchObject({
      code: "invalid-file-url",
    });
  });
});
