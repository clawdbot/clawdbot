import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    fs,
    homeDir: "",
    path,
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
});
