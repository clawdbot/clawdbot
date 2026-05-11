import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnv } from "../test-utils/env.js";
import {
  buildTrustedSafeBinDirs,
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  listWritableExplicitTrustedSafeBinDirs,
} from "./exec-safe-bin-trust.js";

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}

describe("exec safe bin trust", () => {
  it("keeps default trusted dirs limited to immutable system paths", () => {
    const dirs = getTrustedSafeBinDirs({ refresh: true });

    expect(dirs.has(path.resolve("/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/usr/local/bin"))).toBe(false);
    expect(dirs.has(path.resolve("/opt/homebrew/bin"))).toBe(false);
  });

  it("builds trusted dirs from defaults and explicit extra dirs", () => {
    const dirs = buildTrustedSafeBinDirs({
      baseDirs: ["/usr/bin"],
      extraDirs: ["/custom/bin", "/alt/bin", "/custom/bin"],
    });

    expect(dirs.has(path.resolve("/usr/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/custom/bin"))).toBe(true);
    expect(dirs.has(path.resolve("/alt/bin"))).toBe(true);
    expect(dirs.size).toBe(3);
  });

  it("memoizes trusted dirs per explicit trusted-dir snapshot", () => {
    const a = getTrustedSafeBinDirs({
      extraDirs: ["/first/bin"],
      refresh: true,
    });
    const b = getTrustedSafeBinDirs({
      extraDirs: ["/first/bin"],
    });
    const c = getTrustedSafeBinDirs({
      extraDirs: ["/second/bin"],
    });

    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });

  it("validates resolved paths using injected trusted dirs", () => {
    const trusted = new Set([path.resolve("/usr/bin")]);
    expect(
      isTrustedSafeBinPath({
        resolvedPath: "/usr/bin/jq",
        trustedDirs: trusted,
      }),
    ).toBe(true);
    expect(
      isTrustedSafeBinPath({
        resolvedPath: "/tmp/evil/jq",
        trustedDirs: trusted,
      }),
    ).toBe(false);
  });

  it("matches trusted dirs through path-local case folding on case-insensitive filesystems", async () => {
    await withTempDir({ prefix: "OpenClaw-Safe-Bin-" }, async (dir) => {
      const swapped = swapAsciiCase(dir);
      if (swapped === dir) {
        return;
      }
      const originalStat = await fs.stat(dir);
      let swappedStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        swappedStat = await fs.stat(swapped);
      } catch {
        return;
      }
      if (originalStat.dev !== swappedStat.dev || originalStat.ino !== swappedStat.ino) {
        return;
      }

      const dirs = buildTrustedSafeBinDirs({
        baseDirs: [],
        extraDirs: [swapped],
      });

      expect(
        isTrustedSafeBinPath({
          resolvedPath: path.join(dir, "jq"),
          trustedDirs: dirs,
        }),
      ).toBe(true);
    });
  });

  it("keeps case-distinct trusted dirs separate on case-sensitive filesystems", async () => {
    await withTempDir({ prefix: "openclaw-safe-bin-case-" }, async (parent) => {
      const trustedDir = path.join(parent, "ToolBin");
      const untrustedDir = path.join(parent, "toolbin");
      await fs.mkdir(trustedDir);
      try {
        await fs.mkdir(untrustedDir);
      } catch {
        return;
      }

      const dirs = buildTrustedSafeBinDirs({
        baseDirs: [],
        extraDirs: [trustedDir],
      });

      expect(
        isTrustedSafeBinPath({
          resolvedPath: path.join(untrustedDir, "jq"),
          trustedDirs: dirs,
        }),
      ).toBe(false);
    });
  });

  it("does not trust PATH entries by default", () => {
    const injected = `/tmp/openclaw-path-injected-${Date.now()}`;

    withEnv({ PATH: `${injected}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
      const refreshed = getTrustedSafeBinDirs({ refresh: true });
      expect(refreshed.has(path.resolve(injected))).toBe(false);
    });
  });

  it("flags explicitly trusted dirs that are group/world writable", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir({ prefix: "openclaw-safe-bin-trust-" }, async (dir) => {
      try {
        await fs.chmod(dir, 0o777);
        const hits = listWritableExplicitTrustedSafeBinDirs([dir]);
        expect(hits).toEqual([
          {
            dir: path.resolve(dir),
            groupWritable: true,
            worldWritable: true,
          },
        ]);
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
      }
    });
  });
});
