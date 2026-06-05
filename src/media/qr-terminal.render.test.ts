// QR terminal render tests cover terminal QR output formatting.
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { renderQrTerminal } from "./qr-terminal.ts";

const ansiSgr = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
const compactMarginModules = 1;

function visibleLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(ansiSgr, ""))
    .filter((line) => line.length > 0);
}

function maxVisibleWidth(output: string): number {
  return Math.max(...visibleLines(output).map((line) => line.length));
}

function decodeCompactBlock(char: string): [boolean, boolean] {
  if (char === "█") {
    return [true, true];
  }
  if (char === "▀") {
    return [true, false];
  }
  if (char === "▄") {
    return [false, true];
  }
  if (char === " ") {
    return [false, false];
  }
  throw new Error(`Unexpected compact QR character: ${char}`);
}

function decodeCompactQr(output: string, size: number): boolean[] {
  const decoded = Array.from({ length: size * size }, () => false);
  visibleLines(output).forEach((line, lineIndex) => {
    Array.from(line).forEach((char, columnIndex) => {
      const x = columnIndex - compactMarginModules;
      const topY = lineIndex * 2 - compactMarginModules;
      const [top, bottom] = decodeCompactBlock(char);
      for (const [y, value] of [
        [topY, top],
        [topY + 1, bottom],
      ] as const) {
        if (x >= 0 && x < size && y >= 0 && y < size) {
          decoded[y * size + x] = value;
        }
      }
    });
  });
  return decoded;
}

describe("renderQrTerminal (real qrcode runtime)", () => {
  it("keeps per-row ANSI sequence counts in line with typical rows", async () => {
    const sample = "https://wa.me/login/2@SAMPLE-TOKEN-1234567890ABCDEF";
    const rendered = await renderQrTerminal(sample);
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

  it("renders compact output from the same QR matrix", async () => {
    const sample = "https://wa.me/login/2@SAMPLE-TOKEN-1234567890ABCDEF";
    const qr = QRCode.create(sample);
    const full = await renderQrTerminal(sample);
    const compact = await renderQrTerminal(sample, { small: true });

    expect(maxVisibleWidth(compact)).toBeLessThan(maxVisibleWidth(full));
    expect(decodeCompactQr(compact, qr.modules.size)).toEqual(Array.from(qr.modules.data, Boolean));
  });
});
