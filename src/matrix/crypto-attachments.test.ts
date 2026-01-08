import { describe, expect, it } from "vitest";

import {
  decryptMatrixAttachment,
  encryptMatrixAttachment,
} from "./crypto-attachments.js";

describe("matrix crypto attachments", () => {
  it("round trips encrypted attachments", async () => {
    const input = Buffer.from("hello");
    const encrypted = await encryptMatrixAttachment(input);

    expect(encrypted.encrypted.byteLength).toBeGreaterThan(0);
    expect(typeof encrypted.info.iv).toBe("string");
    expect(typeof encrypted.info.v).toBe("string");
    expect(typeof encrypted.info.key).toBe("object");
    expect(typeof encrypted.info.hashes).toBe("object");

    const decrypted = await decryptMatrixAttachment({
      encrypted: encrypted.encrypted,
      file: { ...encrypted.info, url: "mxc://example/file" },
    });

    expect(Buffer.from(decrypted)).toEqual(input);
  });
});
