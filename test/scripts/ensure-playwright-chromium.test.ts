import { describe, expect, it, vi } from "vitest";
import {
  ensurePlaywrightChromium,
  resolvePlaywrightInstallRunner,
} from "../../scripts/ensure-playwright-chromium.mjs";

describe("ensurePlaywrightChromium", () => {
  it("does nothing when the browser binary exists", () => {
    const spawnSync = vi.fn();

    expect(
      ensurePlaywrightChromium({
        executablePath: "/cache/chromium/chrome",
        existsSync: () => true,
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("uses an explicit Chromium executable override", () => {
    const spawnSync = vi.fn();

    expect(
      ensurePlaywrightChromium({
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /snap/bin/chromium " },
        executablePath: "/cache/chromium/chrome",
        existsSync: (path: string) => path === "/snap/bin/chromium",
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails when the explicit Chromium executable override is missing", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn();

    expect(
      ensurePlaywrightChromium({
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/snap/bin/chromium" },
        executablePath: "/cache/chromium/chrome",
        existsSync: () => false,
        log: (line: string) => logs.push(line),
        spawnSync,
      }),
    ).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points to /snap/bin/chromium",
    );
  });

  it("uses a system Chromium binary when Playwright Chromium is missing", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn();

    expect(
      ensurePlaywrightChromium({
        executablePath: "/cache/chromium/chrome",
        existsSync: (path: string) => path === "/usr/bin/chromium-browser",
        log: (line: string) => logs.push(line),
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/chromium-browser");
  });

  it("preserves the intentional missing-browser skip mode", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn();

    expect(
      ensurePlaywrightChromium({
        env: { OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM: "1" },
        executablePath: "/cache/chromium/chrome",
        existsSync: () => false,
        log: (line: string) => logs.push(line),
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("leaves the lane skipped");
  });

  it("installs Chromium through the UI Playwright package when missing", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    let existsCalls = 0;

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        env: { PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: () => ++existsCalls > 1,
        platform: "linux",
        spawnSync,
        stdio: "pipe",
        systemExecutablePath: "",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "pnpm",
      ["--dir", "ui", "exec", "playwright", "install", "chromium"],
      {
        cwd: "/repo",
        env: { PATH: "/bin" },
        shell: false,
        stdio: "pipe",
        windowsVerbatimArguments: undefined,
      },
    );
  });

  it("returns the installer status when Playwright install fails", () => {
    expect(
      ensurePlaywrightChromium({
        executablePath: "/cache/chromium/chrome",
        existsSync: () => false,
        spawnSync: vi.fn(() => ({ status: 23 })),
        stdio: "pipe",
        systemExecutablePath: "",
      }),
    ).toBe(23);
  });

  it("wraps the pnpm command shim on Windows", () => {
    expect(
      resolvePlaywrightInstallRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "pnpm.cmd --dir ui exec playwright install chromium"],
      command: "C:\\Windows\\System32\\cmd.exe",
      shell: false,
      windowsVerbatimArguments: true,
    });
  });
});
