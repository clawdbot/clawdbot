import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFileSync: vi.fn(),
    },
  );
});
vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("../../../../test/helpers/node-builtin-mocks.js");
  const existsSync = vi.fn();
  const readFileSync = vi.fn();
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    { existsSync, readFileSync },
    { mirrorToDefault: true },
  );
});
vi.mock("node:os", async () => {
  const { mockNodeBuiltinModule } = await import("../../../../test/helpers/node-builtin-mocks.js");
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
const { resolveBrowserExecutableForPlatform } = await import("./chrome.executables.js");

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
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/Users/test");
  });

  it("prefers default Chromium browser on macOS", async () => {
    mockMacDefaultBrowser("com.google.Chrome", "/Applications/Google Chrome.app");
    mockChromeExecutableExists();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(exe?.kind).toBe("chrome");
  });

  it("detects Edge via LaunchServices bundle ID (com.microsoft.edgemac)", async () => {
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

  it("falls back to Chrome when Edge LaunchServices lookup has no app path", async () => {
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

  it("falls back when default browser is non-Chromium on macOS", async () => {
    mockMacDefaultBrowser("com.apple.Safari");
    mockChromeExecutableExists();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
  });
});
