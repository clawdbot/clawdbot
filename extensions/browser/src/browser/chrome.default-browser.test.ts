// Browser tests cover chromeefault browser plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFileSync: vi.fn(),
    },
  );
});
vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const accessSync = vi.fn();
  const existsSync = vi.fn();
  const readFileSync = vi.fn();
  return mockNodeBuiltinModule(
    async () => actual,
    { accessSync, constants: actual.constants, existsSync, readFileSync },
    { mirrorToDefault: true },
  );
});
vi.mock("node:os", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const homedir = vi.fn();
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:os")>("node:os"),
    { homedir },
    { mirrorToDefault: true },
  );
});
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
const { resolveBrowserExecutableForPlatform, resolveGoogleChromeExecutableForPlatform } =
  await import("./chrome.executables.js");

describe("browser default executable detection", () => {
  const launchServicesPlist = "com.apple.launchservices.secure.plist";
  const chromeExecutablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  function mockMacDefaultBrowser(bundleId: string, appPath = ""): void {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsStr = Array.isArray(args) ? args.join(" ") : "";
      if (cmd === "/usr/bin/plutil" && argsStr.includes("LSHandlers")) {
        return JSON.stringify([{ LSHandlerURLScheme: "http", LSHandlerRoleAll: bundleId }]);
      }
      if (cmd === "/usr/bin/osascript" && argsStr.includes("path to application id")) {
        return appPath;
      }
      if (cmd === "/usr/bin/defaults") {
        return "Google Chrome";
      }
      return "";
    });
  }

  function mockChromeExecutableExists(): void {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const value = String(p);
      if (value.includes(launchServicesPlist)) {
        return true;
      }
      return value.includes(chromeExecutablePath);
    });
  }

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(fs.accessSync).mockReset();
    vi.mocked(fs.accessSync).mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.homedir).mockReset();
    vi.mocked(os.homedir).mockReturnValue("/Users/test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers default Chromium browser on macOS", () => {
    mockMacDefaultBrowser("com.google.Chrome", "/Applications/Google Chrome.app");
    mockChromeExecutableExists();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(exe?.kind).toBe("chrome");
  });

  it("detects Edge via LaunchServices bundle ID (com.microsoft.edgemac)", () => {
    const edgeExecutablePath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    // macOS LaunchServices registers Edge as "com.microsoft.edgemac", which
    // differs from the CFBundleIdentifier "com.microsoft.Edge" in the app's
    // own Info.plist. Both must be recognised.
    //
    // The existsSync mock deliberately only returns true for the Edge path
    // when checked via the resolved osascript/defaults path — Chrome's
    // fallback candidate path is the only other "existing" binary. This
    // ensures the test fails if the default-browser detection branch is
    // broken, because the fallback candidate list would return Chrome, not
    // Edge.
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsStr = Array.isArray(args) ? args.join(" ") : "";
      if (cmd === "/usr/bin/plutil" && argsStr.includes("LSHandlers")) {
        return JSON.stringify([
          { LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.microsoft.edgemac" },
        ]);
      }
      if (cmd === "/usr/bin/osascript" && argsStr.includes("path to application id")) {
        return "/Applications/Microsoft Edge.app/";
      }
      if (cmd === "/usr/bin/defaults") {
        return "Microsoft Edge";
      }
      return "";
    });
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const value = String(p);
      if (value.includes(launchServicesPlist)) {
        return true;
      }
      // Only Edge (via osascript resolution) and Chrome (fallback candidate)
      // "exist". If default-browser detection breaks, the resolver would
      // return Chrome from the fallback list — not Edge — failing the assert.
      return value === edgeExecutablePath || value.includes(chromeExecutablePath);
    });
    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toBe(edgeExecutablePath);
    expect(exe?.kind).toBe("edge");
  });

  it("falls back to Chrome when Edge LaunchServices lookup has no app path", () => {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsStr = Array.isArray(args) ? args.join(" ") : "";
      if (cmd === "/usr/bin/plutil" && argsStr.includes("LSHandlers")) {
        return JSON.stringify([
          { LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.microsoft.edgemac" },
        ]);
      }
      if (cmd === "/usr/bin/osascript" && argsStr.includes("path to application id")) {
        return "";
      }
      return "";
    });
    mockChromeExecutableExists();
    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(exe?.kind).toBe("chrome");
  });

  it("falls back when default browser is non-Chromium on macOS", () => {
    mockMacDefaultBrowser("com.apple.Safari");
    mockChromeExecutableExists();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("resolves an Opera default-browser launcher to the directly owned binary on Windows", () => {
    const installDir = "C:\\Users\\test\\AppData\\Local\\Programs\\Opera";
    const launcher = `${installDir}\\launcher.exe`;
    const opera = `${installDir}\\100.0.4815.76\\opera.exe`;
    vi.mocked(execFileSync)
      .mockReturnValueOnce("ProgId    REG_SZ    OperaStable")
      .mockReturnValueOnce(`(Default)    REG_SZ    "${launcher}" "%1"`);
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const value = String(candidate);
      return value === launcher || value === opera;
    });
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate).endsWith("installation_status.json")) {
        return JSON.stringify({ _subfolder: "100.0.4815.76" });
      }
      throw new Error(`unexpected file: ${String(candidate)}`);
    });

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "win32",
    );

    expect(exe).toEqual({ kind: "chromium", path: opera });
  });

  it("rejects an unsafe Opera launcher target and falls back to a direct browser", () => {
    const launcher = "C:\\Users\\test\\AppData\\Local\\Programs\\Opera\\launcher.exe";
    vi.mocked(execFileSync)
      .mockReturnValueOnce("ProgId    REG_SZ    OperaStable")
      .mockReturnValueOnce(`(Default)    REG_SZ    "${launcher}" "%1"`);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ _subfolder: "..\\escape" }));
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const value = String(candidate).toLowerCase();
      return (
        value === launcher.toLowerCase() ||
        value.endsWith("\\google\\chrome\\application\\chrome.exe")
      );
    });

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "win32",
    );

    expect(exe?.path.toLowerCase()).toMatch(/\\google\\chrome\\application\\chrome\.exe$/);
  });

  it("treats blank Windows install roots as absent and preserves default path order", () => {
    vi.stubEnv("LOCALAPPDATA", " \t ");
    vi.stubEnv("ProgramFiles", "");
    vi.stubEnv("ProgramFiles(x86)", "   ");
    vi.mocked(os.homedir).mockReturnValue("C:\\Users\\test");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(
      resolveBrowserExecutableForPlatform(
        {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
        "win32",
      ),
    ).toBeNull();
    expect(vi.mocked(fs.existsSync).mock.calls.map(([candidate]) => String(candidate))).toEqual([
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\test\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Users\\test\\AppData\\Local\\Chromium\\Application\\chrome.exe",
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  });

  it("keeps explicit Windows install roots and their discovery precedence", () => {
    vi.stubEnv("LOCALAPPDATA", "D:\\User Apps");
    vi.stubEnv("ProgramFiles", "D:\\System Apps");
    vi.stubEnv("ProgramFiles(x86)", "D:\\System Apps x86");
    const expected = "D:\\System Apps x86\\Google\\Chrome\\Application\\chrome.exe";
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === expected);

    expect(
      resolveBrowserExecutableForPlatform(
        {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
        "win32",
      ),
    ).toEqual({ kind: "chrome", path: expected });
    expect(vi.mocked(fs.existsSync).mock.calls.map(([candidate]) => String(candidate))).toEqual([
      "D:\\User Apps\\Google\\Chrome\\Application\\chrome.exe",
      "D:\\User Apps\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "D:\\User Apps\\Microsoft\\Edge\\Application\\msedge.exe",
      "D:\\User Apps\\Chromium\\Application\\chrome.exe",
      "D:\\User Apps\\Google\\Chrome SxS\\Application\\chrome.exe",
      "D:\\System Apps\\Google\\Chrome\\Application\\chrome.exe",
      expected,
    ]);
  });

  it("keeps custom-root precedence for Google Chrome-only discovery", () => {
    vi.stubEnv("LOCALAPPDATA", "D:\\User Apps");
    vi.stubEnv("ProgramFiles", "D:\\System Apps");
    vi.stubEnv("ProgramFiles(x86)", "D:\\System Apps x86");
    const expected = "D:\\System Apps x86\\Google\\Chrome\\Application\\chrome.exe";
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveGoogleChromeExecutableForPlatform("win32")).toEqual({
      kind: "chrome",
      path: expected,
    });
    expect(vi.mocked(fs.existsSync).mock.calls.map(([candidate]) => String(candidate))).toEqual([
      "D:\\User Apps\\Google\\Chrome\\Application\\chrome.exe",
      "D:\\User Apps\\Google\\Chrome SxS\\Application\\chrome.exe",
      "D:\\System Apps\\Google\\Chrome\\Application\\chrome.exe",
      expected,
    ]);
  });

  it("expands blank Windows registry roots with platform defaults before fallback scanning", () => {
    vi.stubEnv("ProgramFiles", "   ");
    const expected = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    vi.mocked(execFileSync)
      .mockReturnValueOnce("ProgId    REG_SZ    ChromeHTML")
      .mockReturnValueOnce(
        `(Default)    REG_SZ    "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" "%1"`,
      );
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === expected);

    expect(
      resolveBrowserExecutableForPlatform(
        {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
        "win32",
      ),
    ).toEqual({ kind: "chrome", path: expected });
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(expected);
  });

  it("canonicalizes an explicitly configured Opera launcher", () => {
    const installDir = "C:\\Users\\test\\AppData\\Local\\Programs\\Opera";
    const launcher = `${installDir}\\launcher.exe`;
    const opera = `${installDir}\\101.0.4843.33\\opera.exe`;
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const value = String(candidate);
      return value === launcher || value === opera;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ _subfolder: "101.0.4843.33" }));

    const exe = resolveBrowserExecutableForPlatform(
      { executablePath: launcher } as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "win32",
    );

    expect(exe).toEqual({ kind: "custom", path: opera });
  });
});
