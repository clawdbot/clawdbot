// Output Root Guard tests cover the shared build output-root symlink guard.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRealOutputRoot } from "../../scripts/lib/output-root-guard.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("assertRealOutputRoot", () => {
  it("accepts a missing output root", () => {
    const rootDir = createTempDir("openclaw-output-root-guard-");

    expect(() => assertRealOutputRoot(path.join(rootDir, "dist"))).not.toThrow();
  });

  it("propagates failures other than a missing output root", () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const fsImpl = {
      ...fs,
      lstatSync: () => {
        throw failure;
      },
    };

    expect(() => assertRealOutputRoot("/unreadable/dist", { fs: fsImpl })).toThrow(failure);
  });

  it("accepts a real directory output root", () => {
    const rootDir = createTempDir("openclaw-output-root-guard-");
    fs.mkdirSync(path.join(rootDir, "dist"));

    expect(() => assertRealOutputRoot(path.join(rootDir, "dist"))).not.toThrow();
  });

  it("accepts a plain file output root", () => {
    const rootDir = createTempDir("openclaw-output-root-guard-");
    const distPath = path.join(rootDir, "dist");
    fs.writeFileSync(distPath, "stale\n");

    expect(() => assertRealOutputRoot(distPath)).not.toThrow();
  });

  it("rejects a symlinked output root and names the remediation", () => {
    const rootDir = createTempDir("openclaw-output-root-guard-");
    const targetDir = path.join(rootDir, "gateway-dist");
    fs.mkdirSync(targetDir);
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => assertRealOutputRoot(distLink)).toThrow(
      /symbolic link.*Remove the symlink or replace it with a real directory/su,
    );
    expect(fs.readlinkSync(distLink)).toBe(targetDir);
  });

  it("rejects a dangling symlinked output root", () => {
    const rootDir = createTempDir("openclaw-output-root-guard-");
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(path.join(rootDir, "missing-target"), distLink, "dir");

    expect(() => assertRealOutputRoot(distLink)).toThrow(/symbolic link/u);
    expect(fs.lstatSync(distLink).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform === "win32")("rejects an NTFS junction output root", () => {
    const rootDir = createTempDir("openclaw-output-root-guard-");
    const targetDir = path.join(rootDir, "gateway-dist");
    fs.mkdirSync(targetDir);
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(targetDir, distLink, "junction");

    expect(() => assertRealOutputRoot(distLink)).toThrow(/symbolic link/u);
    expect(fs.lstatSync(distLink).isSymbolicLink()).toBe(true);
  });
});
