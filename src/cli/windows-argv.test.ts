import { describe, expect, it } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

describe("normalizeWindowsArgv", () => {
  it("removes duplicated Windows node launcher tokens", () => {
    const platform = mockProcessPlatform("win32");
    try {
      expect(
        normalizeWindowsArgv([
          "openclaw",
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
          "status",
        ]),
      ).toEqual([
        "openclaw",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
        "status",
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves non-launcher arguments containing node.exe", () => {
    const platform = mockProcessPlatform("win32");
    try {
      expect(
        normalizeWindowsArgv([
          "openclaw",
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
          "agent",
          "--message",
          "debug node.exe-wrapper startup",
        ]),
      ).toEqual([
        "openclaw",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
        "agent",
        "--message",
        "debug node.exe-wrapper startup",
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves non-launcher positionals containing node.exe after a duplicated launcher", () => {
    const platform = mockProcessPlatform("win32");
    try {
      expect(
        normalizeWindowsArgv([
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
          "debug node.exe-wrapper startup",
          "--verbose",
        ]),
      ).toEqual([
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
        "debug node.exe-wrapper startup",
        "--verbose",
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves exact node.exe option values outside the launcher prefix", () => {
    const platform = mockProcessPlatform("win32");
    try {
      expect(normalizeWindowsArgv(["openclaw", "run", "--message", "node.exe"])).toEqual([
        "openclaw",
        "run",
        "--message",
        "node.exe",
      ]);
    } finally {
      platform.mockRestore();
    }
  });
});
