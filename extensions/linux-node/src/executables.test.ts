import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecutable } from "./executables.js";

describe("linux-node executable discovery", () => {
  it("caches resolved executables per process environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-linux-node-exec-"));
    const command = `ffmpeg-${process.pid}-${Date.now()}`;
    const expected = join(dir, command);
    writeFileSync(expected, "#!/bin/sh\nexit 0\n");
    chmodSync(expected, 0o755);

    expect(resolveExecutable(command, { PATH: dir })).toBe(expected);
    unlinkSync(expected);
    expect(resolveExecutable(command, { PATH: dir })).toBe(expected);
    rmSync(dir, { recursive: true, force: true });
  });

  it("checks known GeoClue demo paths after PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-linux-node-demo-"));
    const demo = join(dir, "where-am-i");
    writeFileSync(demo, "#!/bin/sh\nexit 0\n");
    chmodSync(demo, 0o755);

    expect(resolveExecutable(`where-am-i-${process.pid}`, { PATH: "" }, [demo])).toBe(demo);
    rmSync(dir, { recursive: true, force: true });
  });
});
