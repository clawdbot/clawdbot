import { describe, expect, it } from "vitest";
import {
  formatTuiAuthCommandArgv,
  resolveCodexCliBin,
  resolveLocalAuthSpawnInvocation,
} from "./tui.js";

describe("formatTuiAuthCommandArgv", () => {
  it("renders bounded redacted argv without shell semantics", () => {
    const rendered = formatTuiAuthCommandArgv("C:\\Users\\%USERNAME%\\codex.exe\n", ["login"]);
    expect(rendered).toContain("%USERNAME%");
    expect(rendered).toContain("\\n");
    expect(rendered).not.toContain("\n");

    const secret = "sk-proof-only-1234567890";
    expect(formatTuiAuthCommandArgv("codex", ["login", secret])).not.toContain(secret);
    expect(
      formatTuiAuthCommandArgv("/tmp/" + "x".repeat(400), ["login"]).length,
    ).toBeLessThanOrEqual(320);
  });
});

describe("resolveCodexCliBin", () => {
  it("returns null or a valid Codex executable path", async () => {
    const result = await resolveCodexCliBin();
    if (result === null) {
      expect(result).toBeNull();
      return;
    }
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("codex");
  });
});

describe("resolveLocalAuthSpawnInvocation", () => {
  it("wraps Windows cmd shims through cmd.exe", () => {
    expect(
      resolveLocalAuthSpawnInvocation({
        command: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
        args: ["login"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd login"],
      options: { windowsHide: true, windowsVerbatimArguments: true },
    });
  });

  it("wraps spaced Windows bat shim paths with outer command-line quoting", () => {
    expect(
      resolveLocalAuthSpawnInvocation({
        command: "C:\\Program Files\\Codex\\codex.bat",
        args: ["login"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\Codex\\codex.bat" login"'],
      options: { windowsHide: true, windowsVerbatimArguments: true },
    });
  });

  it("keeps direct execution for non-wrapper commands", () => {
    expect(
      resolveLocalAuthSpawnInvocation({
        command: "/usr/local/bin/codex",
        args: ["login"],
        platform: "linux",
      }),
    ).toStrictEqual({ command: "/usr/local/bin/codex", args: ["login"], options: {} });
    expect(
      resolveLocalAuthSpawnInvocation({
        command: "C:\\tools\\codex.exe",
        args: ["login"],
        platform: "win32",
      }),
    ).toStrictEqual({ command: "C:\\tools\\codex.exe", args: ["login"], options: {} });
  });
});
