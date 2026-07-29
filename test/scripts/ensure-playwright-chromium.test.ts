// Ensure Playwright Chromium tests cover ensure playwright chromium script behavior.
import { describe, expect, it, vi } from "vitest";
import {
  ensurePlaywrightChromium,
  installLinuxSystemChromiumPackage,
  resolvePlaywrightInstallRunner,
  shouldEnsureFfmpegFromArgv,
  shouldInstallPlaywrightSystemDependencies,
} from "../../scripts/ensure-playwright-chromium.mjs";

describe("ensurePlaywrightChromium", () => {
  it("does nothing when the browser binary exists and runs", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      ensurePlaywrightChromium({
        executablePath: "/cache/chromium/chrome",
        existsSync: () => true,
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith("/cache/chromium/chrome", ["--version"], {
      stdio: "ignore",
    });
  });

  it("uses an explicit Chromium executable override", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      ensurePlaywrightChromium({
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /snap/bin/chromium " },
        executablePath: "/cache/chromium/chrome",
        existsSync: (path: string) => path === "/snap/bin/chromium",
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith("/snap/bin/chromium", ["--version"], {
      stdio: "ignore",
    });
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
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      ensurePlaywrightChromium({
        executablePath: "/cache/chromium/chrome",
        existsSync: (path: string) => path === "/usr/bin/chromium-browser",
        log: (line: string) => logs.push(line),
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith("/usr/bin/chromium-browser", ["--version"], {
      stdio: "ignore",
    });
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/chromium-browser");
  });

  it("installs Playwright ffmpeg when recorded UI tests request it", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        ensureFfmpeg: true,
        env: { PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: (path: string) => path === "/usr/bin/chromium-browser",
        log: (line: string) => logs.push(line),
        spawnSync,
        stdio: "pipe",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith("/usr/bin/chromium-browser", ["--version"], {
      stdio: "ignore",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "pnpm",
      ["--dir", "ui", "exec", "playwright", "install", "ffmpeg"],
      {
        cwd: "/repo",
        env: { PATH: "/bin" },
        shell: false,
        stdio: "pipe",
        windowsVerbatimArguments: undefined,
      },
    );
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/chromium-browser");
  });

  it("skips a broken system Chromium binary and uses the first runnable candidate", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn((path: string) => ({
      status: path === "/usr/bin/google-chrome" ? 0 : 127,
    }));

    expect(
      ensurePlaywrightChromium({
        executablePath: "/cache/chromium/chrome",
        existsSync: (path: string) =>
          path === "/snap/bin/chromium" || path === "/usr/bin/google-chrome",
        log: (line: string) => logs.push(line),
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith("/snap/bin/chromium", ["--version"], {
      stdio: "ignore",
    });
    expect(spawnSync).toHaveBeenCalledWith("/usr/bin/google-chrome", ["--version"], {
      stdio: "ignore",
    });
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/google-chrome");
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

  it("installs Linux system dependencies when Chromium still cannot start in a root lane", () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 127 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 127 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        env: { PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: () => true,
        getuid: () => 0,
        platform: "linux",
        spawnSync,
        stdio: "pipe",
        systemExecutablePath: "",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
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
    expect(spawnSync).toHaveBeenNthCalledWith(
      4,
      "pnpm",
      ["--dir", "ui", "exec", "playwright", "install", "--with-deps", "chromium"],
      {
        cwd: "/repo",
        env: { PATH: "/bin" },
        shell: false,
        stdio: "pipe",
        windowsVerbatimArguments: undefined,
      },
    );
  });

  it("retries with Linux system dependencies when the Chromium install reports missing host deps", () => {
    const logs: string[] = [];
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 23 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });
    let existsCalls = 0;

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        env: { CI: "1", PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: () => ++existsCalls > 1,
        getuid: () => 501,
        log: (line: string) => logs.push(line),
        platform: "linux",
        spawnSync,
        stdio: "pipe",
        systemExecutablePath: "",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "pnpm",
      ["--dir", "ui", "exec", "playwright", "install", "chromium"],
      {
        cwd: "/repo",
        env: { CI: "1", PATH: "/bin" },
        shell: false,
        stdio: "pipe",
        windowsVerbatimArguments: undefined,
      },
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "pnpm",
      ["--dir", "ui", "exec", "playwright", "install", "--with-deps", "chromium"],
      {
        cwd: "/repo",
        env: { CI: "1", PATH: "/bin" },
        shell: false,
        stdio: "pipe",
        windowsVerbatimArguments: undefined,
      },
    );
    expect(logs.join("\n")).toContain("installing Linux system dependencies");
  });

  it("falls back to distro Chromium when Playwright does not support the Linux runner image", () => {
    const logs: string[] = [];
    let installedSystemChromium = false;
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (command === "pnpm" && args.includes("chromium")) {
        return { status: 1 };
      }
      if (command === "apt-get" && args.includes("update")) {
        return { status: 0 };
      }
      if (command === "apt-get" && args.includes("chromium-browser")) {
        installedSystemChromium = true;
        return { status: 0 };
      }
      if (command === "/usr/bin/chromium-browser") {
        return { status: installedSystemChromium ? 0 : 127 };
      }
      return { status: 1 };
    });

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        env: { CI: "1", PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: (path: string) =>
          installedSystemChromium && path === "/usr/bin/chromium-browser",
        getuid: () => 0,
        log: (line: string) => logs.push(line),
        platform: "linux",
        spawnSync,
        stdio: "pipe",
        systemExecutablePath: "",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "apt-get",
      ["update", "-qq"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "apt-get",
      ["install", "-y", "chromium-browser"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
    expect(logs.join("\n")).toContain("installing a system Chromium package");
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/chromium-browser");
  });

  it("does not install Linux system dependencies for an unprivileged local lane", () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 127 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 127 });

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        env: { PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: () => true,
        getuid: () => 501,
        platform: "linux",
        spawnSync,
        stdio: "pipe",
        systemExecutablePath: "",
      }),
    ).toBe(1);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("reinstalls Chromium when the cached executable exists but cannot start", () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 127 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        env: { PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: () => true,
        platform: "linux",
        spawnSync,
        stdio: "pipe",
        systemExecutablePath: "",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenNthCalledWith(1, "/cache/chromium/chrome", ["--version"], {
      stdio: "ignore",
    });
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
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
    expect(spawnSync).toHaveBeenNthCalledWith(3, "/cache/chromium/chrome", ["--version"], {
      stdio: "ignore",
    });
  });

  it("returns the installer status when Playwright install fails", () => {
    expect(
      ensurePlaywrightChromium({
        executablePath: "/cache/chromium/chrome",
        existsSync: () => false,
        platform: "darwin",
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

  it("wraps the dependency install command shim on Windows", () => {
    expect(
      resolvePlaywrightInstallRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        platform: "win32",
        withDeps: true,
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "pnpm.cmd --dir ui exec playwright install --with-deps chromium"],
      command: "C:\\Windows\\System32\\cmd.exe",
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("allows dependency installation for Linux CI lanes", () => {
    expect(
      shouldInstallPlaywrightSystemDependencies({
        env: { CI: "true" },
        getuid: () => 501,
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      shouldInstallPlaywrightSystemDependencies({
        env: { CI: "1" },
        getuid: () => 501,
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      shouldInstallPlaywrightSystemDependencies({
        env: { OPENCLAW_TESTBOX: "1" },
        getuid: () => 501,
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("installs Linux system Chromium packages with sudo for non-root lanes", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      installLinuxSystemChromiumPackage({
        cwd: "/repo",
        env: { PATH: "/bin" },
        getuid: () => 501,
        platform: "linux",
        spawnSync,
        stdio: "pipe",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenNthCalledWith(1, "sudo", ["-n", "true"], { stdio: "ignore" });
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "sudo",
      ["-n", "apt-get", "update", "-qq"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      3,
      "sudo",
      ["-n", "apt-get", "install", "-y", "chromium-browser"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
  });

  it("allows QA scenario runners to skip optional Playwright ffmpeg", () => {
    expect(shouldEnsureFfmpegFromArgv(["node", "scripts/ensure-playwright-chromium.mjs"])).toBe(
      true,
    );
    expect(
      shouldEnsureFfmpegFromArgv([
        "node",
        "scripts/ensure-playwright-chromium.mjs",
        "--skip-ffmpeg",
      ]),
    ).toBe(false);
  });
});
