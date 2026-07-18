// Qqbot tests cover log helpers plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = await vi.hoisted(async () => {
  const fsLocal = await import("node:fs");
  const pathLocal = await import("node:path");
  return {
    fs: fsLocal,
    homeDir: "",
    path: pathLocal,
  };
});

vi.mock("../../utils/platform.js", () => ({
  getHomeDir: () => platformMock.homeDir,
  getQQBotDataDir: (...subPaths: string[]) => {
    const dir = platformMock.path.join(platformMock.homeDir, ".openclaw", "qqbot", ...subPaths);
    platformMock.fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  isWindows: () => false,
}));

import { buildBotLogsResult } from "./log-helpers.js";

describe("buildBotLogsResult", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qqbot-logs-"));
    platformMock.homeDir = tempHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("suffixes same-second log exports instead of overwriting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T10:11:12.345Z"));
    const logDir = path.join(tempHome, ".openclaw", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "gateway.log"), "line 1\nline 2\n", "utf8");

    const first = buildBotLogsResult();
    const second = buildBotLogsResult();

    expect(typeof first).toBe("object");
    expect(typeof second).toBe("object");
    if (!first || !second || typeof first === "string" || typeof second === "string") {
      throw new Error("expected file upload results");
    }
    expect(path.basename(first.filePath)).toBe("bot-logs-2026-05-05T10-11-12.txt");
    expect(path.basename(second.filePath)).toBe("bot-logs-2026-05-05T10-11-12-2.txt");
    expect(fs.readFileSync(first.filePath, "utf8")).toContain("line 1");
    expect(fs.readFileSync(second.filePath, "utf8")).toContain("line 2");
  });

  it("completes short fs.readSync tail windows before selecting lines", () => {
    const logDir = path.join(tempHome, ".openclaw", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "gateway.log");
    const lines = Array.from(
      { length: 40 },
      (_, index) => `line ${String(index + 1).padStart(2, "0")}`,
    );
    const contents = `${lines.join("\n")}\n`;
    fs.writeFileSync(logFile, contents, "utf8");

    const realReadSync = fs.readSync.bind(fs) as typeof fs.readSync;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      return realReadSync(fd, buffer, offset, Math.min(length, 7), position);
    }) as typeof fs.readSync);

    const result = buildBotLogsResult();

    expect(readSpy.mock.calls.length).toBeGreaterThan(1);
    expect(typeof result).toBe("object");
    if (!result || typeof result === "string") {
      throw new Error("expected file upload result");
    }
    const exportedLogs = fs.readFileSync(result.filePath, "utf8");
    expect(exportedLogs).toContain("line 01");
    expect(exportedLogs).toContain("line 40");
    expect(exportedLogs).not.toContain("\0");
  });
});
