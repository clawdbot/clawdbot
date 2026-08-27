// Tests safe boundary file reads against upstream fs-safe behavior.
import fs from "node:fs";
import path from "node:path";
import * as upstream from "@openclaw/fs-safe/advanced";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as shim from "./boundary-file-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("root file open shim", () => {
  it("separates missing, unreadable, and boundary-violating open failures", () => {
    const messageFor = (failure: upstream.RootFileOpenFailure) =>
      shim.describeRootFileOpenFailure({
        failure,
        subject: "plugin entry path",
        boundaryLabel: "plugin root",
        filePath: "/plugins/demo/index.js",
      });

    expect(
      messageFor({
        ok: false,
        reason: "path",
        error: Object.assign(new Error("nope"), { code: "ENOENT" }),
      }),
    ).toBe("plugin entry path not found: /plugins/demo/index.js");
    expect(
      messageFor({
        ok: false,
        reason: "path",
        error: Object.assign(new Error("nope"), { code: "ENOTDIR" }),
      }),
    ).toBe("plugin entry path not found: /plugins/demo/index.js");
    // fs-safe also reports symlink loops as `path`; those are unreadable, not absent.
    expect(
      messageFor({
        ok: false,
        reason: "path",
        error: Object.assign(new Error("loop"), { code: "ELOOP" }),
      }),
    ).toBe("plugin entry path could not be read (ELOOP): /plugins/demo/index.js");
    expect(messageFor({ ok: false, reason: "validation" })).toBe(
      "plugin entry path escapes plugin root or fails alias checks: /plugins/demo/index.js",
    );
    expect(
      messageFor({
        ok: false,
        reason: "io",
        error: Object.assign(new Error("io"), { code: "EACCES" }),
      }),
    ).toBe("plugin entry path could not be read (EACCES): /plugins/demo/index.js");
  });

  it("preserves the existing overflow error for fs-safe descriptor reads", async () => {
    const dir = tempDirs.make("openclaw-boundary-file-read-");
    const filePath = path.join(dir, "oversized.txt");
    fs.writeFileSync(filePath, "oversized");

    const asyncFd = fs.openSync(filePath, "r");
    try {
      await expect(shim.readFileDescriptorBounded(asyncFd, 4)).rejects.toThrow(
        new RangeError("File exceeds 4 bytes"),
      );
    } finally {
      fs.closeSync(asyncFd);
    }

    const syncFd = fs.openSync(filePath, "r");
    try {
      expect(() => shim.readFileDescriptorBoundedSync(syncFd, 4)).toThrow(
        new RangeError("File exceeds 4 bytes"),
      );
    } finally {
      fs.closeSync(syncFd);
    }
  });
});
