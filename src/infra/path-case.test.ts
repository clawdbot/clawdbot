import { describe, expect, it } from "vitest";
import { sameFsObject } from "./path-case.js";

type FsObjectIdentity = Parameters<typeof sameFsObject>[0];

function identity(dev: number, ino: number): FsObjectIdentity {
  return { dev, ino };
}

describe("sameFsObject", () => {
  it("treats zero identity fields as exact values rather than wildcards", () => {
    expect(sameFsObject(identity(0, 11), identity(8, 11))).toBe(false);
    expect(sameFsObject(identity(7, 0), identity(7, 12))).toBe(false);
  });
});
