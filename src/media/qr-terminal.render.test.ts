import { describe, expect, it } from "vitest";
import { renderQrTerminal } from "./qr-terminal.ts";

describe("renderQrTerminal (real qrcode runtime)", () => {
  it("keeps per-row ANSI sequence counts in line with typical rows", async () => {
    const sample = "https://wa.me/login/2@SAMPLE-TOKEN-1234567890ABCDEF";
    const rendered = await renderQrTerminal(sample);
    const ansiSgr = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
    const escCounts = rendered
      .split(/\r?\n/)
      .map((line) => (line.match(ansiSgr) ?? []).length)
      .filter((count) => count > 0);
    expect(escCounts.length).toBeGreaterThan(0);
    const sorted = escCounts.toSorted((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const max = Math.max(...escCounts);
    expect(median).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(median * 6);
  });
});
