import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const platformMocks = vi.hoisted(() => ({
  checkSilkWasmAvailable: vi.fn(async () => true),
  getHomeDir: vi.fn(() => ""),
  getQQBotDataDir: vi.fn(() => ""),
  getTempDir: vi.fn(() => ""),
  isWindows: vi.fn(() => true),
}));
const debugLogMock = vi.hoisted(() => vi.fn());

vi.mock("./platform.js", () => platformMocks);
vi.mock("./log.js", () => ({ debugLog: debugLogMock }));

import { runDiagnostics } from "./diagnostics.js";

describe("QQBot startup diagnostics", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not probe legacy storage or recommend an unsupported override", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-diagnostics-"));
    tempRoots.push(testRoot);
    const windowsHome = path.join(testRoot, "Users", "张 家豪");
    const openclawHome = path.join(testRoot, "OpenClaw Home");
    fs.mkdirSync(windowsHome, { recursive: true });
    fs.mkdirSync(openclawHome, { recursive: true });
    vi.stubEnv("HOME", windowsHome);
    vi.stubEnv("USERPROFILE", windowsHome);
    vi.stubEnv("OPENCLAW_HOME", openclawHome);

    const legacyDataDir = path.join(windowsHome, ".openclaw", "qqbot");
    platformMocks.getHomeDir.mockReturnValue(windowsHome);
    platformMocks.getTempDir.mockReturnValue(path.join(openclawHome, "tmp"));
    platformMocks.getQQBotDataDir.mockImplementation(() => {
      fs.mkdirSync(legacyDataDir, { recursive: true });
      return legacyDataDir;
    });

    const report = await runDiagnostics();
    const output = [JSON.stringify(report), ...debugLogMock.mock.calls.flat()].join("\n");

    expect(report.homeDir).toBe(windowsHome);
    expect(report).not.toHaveProperty("dataDir");
    expect(platformMocks.getQQBotDataDir).not.toHaveBeenCalled();
    expect(fs.existsSync(legacyDataDir)).toBe(false);
    expect(output).not.toContain("Data dir");
    expect(output).not.toContain("QQBOT_DATA_DIR");
  });
});
