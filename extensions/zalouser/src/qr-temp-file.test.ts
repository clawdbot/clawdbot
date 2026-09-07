import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it } from "vitest";
import { writeQrDataUrlToTempFile } from "./qr-temp-file.js";

describe("writeQrDataUrlToTempFile", () => {
  const profile = `test/profile-${process.pid}`;
  const expectedPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-zalouser-qr-test-profile-${process.pid}.png`,
  );

  afterEach(async () => {
    await fs.rm(expectedPath, { force: true });
  });

  it("overwrites the stable per-profile path and enforces private mode", async () => {
    const firstData = Buffer.from("first-qr-image");
    const secondData = Buffer.from("second-qr-image");
    const first = await writeQrDataUrlToTempFile(
      `data:image/png;base64,${firstData.toString("base64")}`,
      profile,
    );
    expect(first).toBe(expectedPath);
    await fs.chmod(expectedPath, 0o644);

    const second = await writeQrDataUrlToTempFile(
      `data:image/png;base64,${secondData.toString("base64")}`,
      profile,
    );
    expect(second).toBe(expectedPath);
    await expect(fs.readFile(expectedPath)).resolves.toEqual(secondData);
    if (process.platform !== "win32") {
      expect((await fs.stat(expectedPath)).mode & 0o777).toBe(0o600);
    }
  });
});
