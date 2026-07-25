import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  sha256Base64,
  sha256Base64Url,
  sha256Base64UrlPrefix,
  sha256File,
  sha256Hex,
  sha256HexPrefix,
} from "./crypto-digest.js";

const HOSTILE_BYTES = Uint8Array.from([0, 255, 128, 195, 40, 226, 40, 161]);
const HOSTILE_BYTES_SHA256 = "bd88bda48025bbcf78712d1ff89b55b1cca10c3a9b36c275af350f52b5987902";

describe("crypto digest helpers", () => {
  it("hashes Unicode strings as UTF-8", () => {
    const input = "Iñtërnâtiônàlizætiøn☃💩";

    expect(sha256Hex(input)).toBe(
      "75781ac975ff76899629e996d8e96aa5e89db77315473d8b3281cb8aa700b2e6",
    );
    expect(sha256Base64(input)).toBe("dXgayXX/domWKemW2Olqpeidt3MVRz2LMoHLiqcAsuY=");
    expect(sha256Base64Url(input)).toBe("dXgayXX_domWKemW2Olqpeidt3MVRz2LMoHLiqcAsuY");
  });

  it("hashes arbitrary bytes without text decoding", () => {
    expect(sha256Hex(HOSTILE_BYTES)).toBe(HOSTILE_BYTES_SHA256);
    expect(sha256Base64(HOSTILE_BYTES)).toBe("vYi9pIAlu894cS0f+JtVscyhDDqbNsJ1rzUPUrWYeQI=");
  });

  it("returns an exact hexadecimal prefix", () => {
    expect(sha256HexPrefix(HOSTILE_BYTES, 12)).toBe(HOSTILE_BYTES_SHA256.slice(0, 12));
    expect(sha256Base64UrlPrefix(HOSTILE_BYTES, 12)).toBe("vYi9pIAlu894");
  });

  it("streams file bytes through the same digest contract", async () => {
    await withTempDir({ prefix: "openclaw-crypto-digest-" }, async (dir) => {
      const filePath = path.join(dir, "hostile.bin");
      await fs.writeFile(filePath, HOSTILE_BYTES);

      await expect(sha256File(filePath)).resolves.toBe(HOSTILE_BYTES_SHA256);
    });
  });

  it("preserves stream failure context when hashing a file", async () => {
    await withTempDir({ prefix: "openclaw-crypto-digest-" }, async (dir) => {
      const filePath = path.join(dir, "missing.bin");

      await expect(sha256File(filePath)).rejects.toMatchObject({
        message: expect.stringContaining(`Failed to hash file ${filePath}:`),
        cause: expect.objectContaining({ code: "ENOENT" }),
      });
    });
  });
});
