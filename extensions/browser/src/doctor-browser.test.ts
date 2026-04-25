import { describe, expect, it, vi } from "vitest";
import { noteChromeMcpBrowserReadiness } from "./doctor-browser.js";

describe("browser doctor readiness", () => {
  it("does nothing when Chrome MCP is not configured", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          profiles: {
            openclaw: { color: "#FF4500" },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        env: { DISPLAY: ":99" },
        getUid: () => 1000,
        resolveManagedExecutable: () => ({ kind: "chrome", path: "/usr/bin/google-chrome" }),
      },
    );
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("warns when managed browser profiles have no local executable", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          profiles: {
            openclaw: { color: "#FF4500" },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        env: { DISPLAY: ":99" },
        getUid: () => 1000,
        resolveManagedExecutable: () => null,
      },
    );

    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("No Chromium-based browser executable was found on this host"),
      "Browser",
    );
  });

  it("warns when managed browser launch needs display and no-sandbox adjustments", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          headless: false,
          noSandbox: false,
          profiles: {
            openclaw: { color: "#FF4500" },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        env: {},
        getUid: () => 0,
        resolveManagedExecutable: () => ({ kind: "chromium", path: "/usr/bin/chromium" }),
      },
    );

    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("No DISPLAY or WAYLAND_DISPLAY is set"),
      "Browser",
    );
    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("browser.noSandbox: true"),
      "Browser",
    );
  });

  it("warns when Chrome MCP is configured but Chrome is missing", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          defaultProfile: "user",
        },
      },
      {
        noteFn,
        platform: "darwin",
        resolveChromeExecutable: () => null,
      },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(String(noteFn.mock.calls[0]?.[0])).toContain("Google Chrome was not found");
    expect(String(noteFn.mock.calls[0]?.[0])).toContain("brave://inspect/#remote-debugging");
  });

  it("warns when detected Chrome is too old for Chrome MCP", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          profiles: {
            chromeLive: {
              driver: "existing-session",
              color: "#00AA00",
            },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        resolveChromeExecutable: () => ({ path: "/usr/bin/google-chrome" }),
        readVersion: () => "Google Chrome 143.0.7499.4",
      },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(String(noteFn.mock.calls[0]?.[0])).toContain("too old");
    expect(String(noteFn.mock.calls[0]?.[0])).toContain("Chrome 144+");
  });

  it("reports the detected Chrome version for existing-session profiles", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          profiles: {
            chromeLive: {
              driver: "existing-session",
              color: "#00AA00",
            },
          },
        },
      },
      {
        noteFn,
        platform: "win32",
        resolveChromeExecutable: () => ({
          path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        }),
        readVersion: () => "Google Chrome 144.0.7534.0",
      },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(String(noteFn.mock.calls[0]?.[0])).toContain(
      "Detected Chrome Google Chrome 144.0.7534.0",
    );
  });

  it("skips Chrome auto-detection when profiles use explicit userDataDir", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          profiles: {
            braveLive: {
              driver: "existing-session",
              userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
              color: "#FB542B",
            },
          },
        },
      },
      {
        noteFn,
        resolveChromeExecutable: () => {
          throw new Error("should not look up Chrome");
        },
      },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(String(noteFn.mock.calls[0]?.[0])).toContain("explicit Chromium user data directory");
    expect(String(noteFn.mock.calls[0]?.[0])).toContain("brave://inspect/#remote-debugging");
  });
});
