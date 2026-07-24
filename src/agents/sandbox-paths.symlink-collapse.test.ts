import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSandboxPath } from "./sandbox-paths.js";

/**
 * Regression coverage for the symlink-then-`..` boundary bypass.
 *
 * `path.resolve` (and Node's JS `fs.realpathSync`) collapse a `..` segment
 * lexically — treating the preceding component as an ordinary directory — before
 * any symlink is resolved. When that preceding component is a symlink, the
 * lexical collapse lands on a harmless in-root path while the OS (which resolves
 * per-component, honoring the symlink first) resolves the SAME raw string to a
 * location outside the workspace. A validator that pre-collapses therefore
 * approves an input whose real resolution escapes the boundary.
 */
describe("assertSandboxPath — symlink-then-.. boundary soundness", () => {
  let ws: string;
  let root: string;
  let secret: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-symcollapse-"));
    fs.mkdirSync(path.join(ws, "workspace"), { recursive: true });
    root = fs.realpathSync(path.join(ws, "workspace"));
    secret = path.join(ws, "SECRET-outside");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(path.join(secret, "loot.txt"), "TOP SECRET host file\n");
    // root/sub/up -> ".."  : resolves to `root`; a following `..` then leaves the workspace.
    fs.symlinkSync("..", path.join(root, "sub", "up"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("ground truth: the OS resolves the raw payload outside the workspace", () => {
    // String concat (no path.join) so `..` is NOT lexically pre-collapsed.
    const raw = `${root}/sub/up/../SECRET-outside/loot.txt`;
    const content = fs.readFileSync(raw, "utf8");
    expect(content).toContain("TOP SECRET");
    expect(fs.realpathSync.native(raw).startsWith(root + path.sep)).toBe(false);
  });

  it("rejects a symlink-then-.. path that escapes the workspace", async () => {
    await expect(
      assertSandboxPath({
        filePath: "sub/up/../SECRET-outside/loot.txt",
        cwd: root,
        root,
      }),
    ).rejects.toThrow(/escape/i);
  });

  it("rejects a symlink-then-.. parent used for a would-be write", async () => {
    await expect(
      assertSandboxPath({
        filePath: "sub/up/../SECRET-outside/implant.txt",
        cwd: root,
        root,
      }),
    ).rejects.toThrow(/escape/i);
  });

  it("still accepts benign in-root paths, including foo/../bar and in-root symlinks", async () => {
    fs.mkdirSync(path.join(root, "real", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "real", "file.txt"), "ok\n");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "inLink"));

    await expect(
      assertSandboxPath({ filePath: "real/file.txt", cwd: root, root }),
    ).resolves.toBeTruthy();
    await expect(
      assertSandboxPath({ filePath: "real/../real/file.txt", cwd: root, root }),
    ).resolves.toBeTruthy();
    await expect(
      assertSandboxPath({ filePath: "inLink/file.txt", cwd: root, root }),
    ).resolves.toBeTruthy();
    await expect(
      assertSandboxPath({ filePath: "inLink/../real/nested", cwd: root, root }),
    ).resolves.toBeTruthy();
    await expect(
      assertSandboxPath({ filePath: "real/nested/new/deep.txt", cwd: root, root }),
    ).resolves.toBeTruthy();
  });

  it("accepts the workspace root itself (whose real parent is outside root)", async () => {
    // e.g. exec workdir resolution passes the absolute workspace dir as the target.
    await expect(
      assertSandboxPath({ filePath: root, cwd: process.cwd(), root }),
    ).resolves.toBeTruthy();
    await expect(assertSandboxPath({ filePath: ".", cwd: root, root })).resolves.toBeTruthy();
    await expect(assertSandboxPath({ filePath: "sub", cwd: root, root })).resolves.toBeTruthy();
  });
});
