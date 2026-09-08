import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLogTextSince,
  readLogTextTail,
  readLogTextWindow,
} from "../../scripts/lib/cross-os-release-checks/logs.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeLog(contents: string) {
  const logPath = path.join(tempDirs.make("openclaw-cross-os-release-logs-"), "release.log");
  fs.writeFileSync(logPath, contents, "utf8");
  return logPath;
}

describe("cross-OS release log reads", () => {
  it("fills bounded log windows across positional short reads", () => {
    const logPath = writeLog("abcdef");
    const realReadSync = fs.readSync.bind(fs);
    let shortReadCalls = 0;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: fs.ReadPosition | null,
    ) => {
      shortReadCalls += 1;
      return realReadSync(fd, buffer, offset, Math.min(length, 2), position);
    }) as typeof fs.readSync);

    try {
      expect(readLogTextTail(logPath)).toBe("abcdef");
      expect(readLogTextSince(logPath, 2)).toBe("cdef");
      expect(readLogTextWindow(logPath, { maxBytes: 4 })).toBe("cdef");
      expect(readLogTextSince(logPath, 6)).toBe("");
      expect(readLogTextSince(logPath, 100)).toBe("");
      expect(shortReadCalls).toBeGreaterThan(3);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("preserves complete and multibyte log text", () => {
    const logPath = writeLog("A¢€𐍈B");

    expect(readLogTextTail(logPath)).toBe("A¢€𐍈B");
    expect(readLogTextWindow(logPath, { maxBytes: 5 })).toBe("𐍈B");
  });
});
