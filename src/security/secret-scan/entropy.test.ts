import { describe, expect, it } from "vitest";

import { hexEntropy, shannonEntropy } from "./entropy.js";
import { scanText } from "./scan.js";

describe("secret scan entropy", () => {
  const detect = (value: string) => scanText(value, { config: { mode: "block" } });

  it("flags high entropy base64/base64url strings", () => {
    const base64 = "c3VwZXIgbG9uZyBzdHJpbmcgc2hvdWxkIGNhdXNlIGVub3VnaCBlbnRyb3B5";
    const base64url =
      "I6FwzQZFL9l-44nviI1F04OTmorMaVQf9GS4Oe07qxL_vNkW6CRas4Lo42vqJMT0M6riJfma_f-pTAuoX2U=";
    expect(detect(base64).blocked).toBe(true);
    expect(detect(base64url).blocked).toBe(true);
  });

  it("does not flag low entropy strings", () => {
    const base64Short = "c3VwZXIgc2VjcmV0IHZhbHVl";
    const hexLow = "aaaaaa";
    expect(detect(base64Short).blocked).toBe(false);
    expect(detect(hexLow).blocked).toBe(false);
  });

  it("reduces entropy for numeric hex strings", () => {
    const value = "0123456789";
    expect(hexEntropy(value)).toBeLessThan(shannonEntropy(value));
  });

  it("does not adjust entropy when hex includes letters", () => {
    const value = "12345a";
    expect(hexEntropy(value)).toBeCloseTo(shannonEntropy(value));
  });
});
