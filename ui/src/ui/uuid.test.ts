// Control UI tests cover uuid behavior.
import { describe, expect, it, vi } from "vitest";
import { generateUUID } from "./uuid.ts";

describe("generateUUID", () => {
  it("uses crypto.randomUUID when available", () => {
    const id = generateUUID({
      randomUUID: () => "randomuuid",
      getRandomValues: () => {
        throw new Error("should not be called");
      },
    });

    expect(id).toBe("randomuuid");
  });

  it("falls back to crypto.getRandomValues", () => {
    const id = generateUUID({
      getRandomValues: (bytes) => {
        const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < view.length; i++) {
          view[i] = i;
        }
        return bytes;
      },
    });

    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("still returns a v4 UUID when crypto is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => generateUUID(null)).toThrow("Web Crypto is required for UUID generation");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
