// Qqbot tests cover decode media path plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import { decodeMediaPath } from "./decode-media-path.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function restoreEnv(name: "HOME" | "USERPROFILE", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
});

describe("decodeMediaPath", () => {
  it("preserves Windows home-relative paths with digit segments", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = String.raw`C:\Users\operator`;

    expect(decodeMediaPath(String.raw`~\1\photo.png`)).toBe(
      String.raw`C:\Users\operator\1\photo.png`,
    );
  });

  it("prefers USERPROFILE for Windows home-relative paths when HOME is POSIX-style", () => {
    process.env.HOME = "/c/Users/operator";
    process.env.USERPROFILE = String.raw`C:\Users\operator`;

    expect(decodeMediaPath(String.raw`~\1\photo.png`)).toBe(
      String.raw`C:\Users\operator\1\photo.png`,
    );
  });
});
