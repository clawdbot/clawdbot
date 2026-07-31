import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDotEnvFile } from "./dotenv-global.js";

const logWarnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
  logWarnSpy.mockClear();
  for (const fn of cleanups.splice(0)) {
    fn();
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "openclaw-dotenv-global-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function tmpFile(name: string, contents: string): string {
  const d = tmpDir();
  const p = join(d, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("readDotEnvFile", () => {
  it("reads a small .env file", () => {
    const filePath = tmpFile(".env", "API_KEY=secret\nOTHER_KEY=value\n");
    const result = readDotEnvFile({ filePath });
    expect(result).not.toBeNull();
    expect(result!.entries).toContainEqual({ key: "API_KEY", value: "secret" });
    expect(result!.entries).toContainEqual({ key: "OTHER_KEY", value: "value" });
    expect(logWarnSpy).not.toHaveBeenCalled();
  });

  it("reads a symlinked .env file", () => {
    const d = tmpDir();
    const realPath = join(d, "real.env");
    writeFileSync(realPath, "REAL_KEY=from_symlink_target\n", "utf8");
    const linkPath = join(d, ".env");
    symlinkSync(realPath, linkPath);
    const result = readDotEnvFile({ filePath: linkPath });
    expect(result).not.toBeNull();
    expect(result!.entries).toContainEqual({
      key: "REAL_KEY",
      value: "from_symlink_target",
    });
  });

  it("returns null for a missing file (quiet)", () => {
    const d = tmpDir();
    const result = readDotEnvFile({ filePath: join(d, "nonexistent.env"), quiet: true });
    expect(result).toBeNull();
    expect(logWarnSpy).not.toHaveBeenCalled();
  });

  it("warns when an oversized .env file is skipped", () => {
    const d = tmpDir();
    // Create a file larger than 1 MiB so the bounded read rejects it.
    const filePath = join(d, "oversized.env");
    const large = Buffer.alloc(2 * 1024 * 1024, "x");
    large.write("KEY=value\n", 0, "utf8");
    writeFileSync(filePath, large);
    const result = readDotEnvFile({ filePath, quiet: false });
    expect(result).toBeNull();
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping oversized .env file (max"),
    );
  });
});
