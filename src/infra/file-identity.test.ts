import { describe, expect, it } from "vitest";
import { sameFileIdentity, type FileIdentityStat } from "./fs-safe-advanced.js";

function stat(dev: number | bigint, ino: number | bigint): FileIdentityStat {
  return { dev, ino };
}

describe("sameFileIdentity", () => {
  it.each([
    {
      name: "accepts exact dev+ino match",
      left: stat(7, 11),
      right: stat(7, 11),
      platform: "linux" as const,
      expected: true,
    },
    {
      name: "rejects inode mismatch",
      left: stat(7, 11),
      right: stat(7, 12),
      platform: "linux" as const,
      expected: false,
    },
    {
      name: "rejects dev mismatch on non-windows",
      left: stat(7, 11),
      right: stat(8, 11),
      platform: "linux" as const,
      expected: false,
    },
    {
      name: "keeps dev strictness on linux when one side is zero",
      left: stat(0, 11),
      right: stat(8, 11),
      platform: "linux" as const,
      expected: false,
    },
    {
      name: "accepts win32 dev mismatch when either side is 0",
      left: stat(0, 11),
      right: stat(8, 11),
      platform: "win32" as const,
      expected: true,
    },
    {
      name: "accepts win32 dev mismatch when right side is 0",
      left: stat(7, 11),
      right: stat(0, 11),
      platform: "win32" as const,
      expected: true,
    },
    {
      name: "keeps dev strictness on win32 when both dev values are non-zero",
      left: stat(7, 11),
      right: stat(8, 11),
      platform: "win32" as const,
      expected: false,
    },
    {
      name: "handles bigint stats",
      left: stat(0n, 11n),
      right: stat(8n, 11n),
      platform: "win32" as const,
      expected: true,
    },
  ])("$name", ({ left, right, platform, expected }) => {
    expect(sameFileIdentity(left, right, platform)).toBe(expected);
  });
});
