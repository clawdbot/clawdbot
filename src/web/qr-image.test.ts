import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { renderQrPngBase64 } from "./qr-image.js";

describe("renderQrPngBase64", () => {
  it("renders a PNG data payload", async () => {
    const b64 = await renderQrPngBase64("moltbot");
    const buf = Buffer.from(b64, "base64");
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("avoids dynamic require of qrcode-terminal vendor modules", async () => {
    const sourcePath = resolve(process.cwd(), "src/web/qr-image.ts");
    const source = await readFile(sourcePath, "utf-8");
    expect(source).not.toContain("createRequire(");
    expect(source).not.toContain('require("qrcode-terminal/vendor/QRCode")');
    expect(source).toContain("qrcode-terminal/vendor/QRCode/index.js");
    expect(source).toContain("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js");
  });
});
