import { describe, expect, it } from "vitest";
import {
  assertProofImage,
  proofImageTag,
  proofStorageBytes,
} from "../../scripts/mantis/telegram-proof-storage.mts";

describe("isolated Telegram storage identity", () => {
  it("pins canonical tags to the complete immutable image identity", () => {
    const image = "a".repeat(64);
    expect(proofImageTag(image)).toBe(`localhost/mantis-proof-${image}:candidate`);
    expect(proofImageTag(`sha256:${image}`)).toBe(proofImageTag(image));
    expect(() => assertProofImage(image, `sha256:${image}`)).not.toThrow();
    expect(() => assertProofImage(image, "b".repeat(64))).toThrow("identity changed");
  });

  it("rejects mutable, short, or injected image identifiers", () => {
    for (const image of [
      "latest",
      "abc123",
      "a".repeat(63),
      "A".repeat(64),
      "a".repeat(64) + "\n",
    ]) {
      expect(() => proofImageTag(image)).toThrow("Invalid immutable image identity");
    }
    expect(proofStorageBytes).toBe(32 * 1024 ** 3);
  });
});
