import { describe, expect, it } from "vitest";
import { buildBrowserDoctorReport } from "./doctor.js";

function collectWarningCheckIds(checks: readonly { id: string; status: string }[]): string[] {
  const ids: string[] = [];
  for (const check of checks) {
    if (check.status === "warn") {
      ids.push(check.id);
    }
  }
  return ids;
}

describe("buildBrowserDoctorReport", () => {
  it("reports stopped managed browsers as launchable diagnostics", () => {
    const report = buildBrowserDoctorReport({
      platform: "linux",
      env: { DISPLAY: ":99" },
      uid: 1000,
      status: {
        enabled: true,
        profile: "openclaw",
        driver: "openclaw",
        transport: "cdp",
        running: false,
        cdpReady: false,
        cdpHttp: false,
        pid: null,
        cdpPort: 18800,
        cdpUrl: "http://127.0.0.1:18800",
        chosenBrowser: null,
        detectedBrowser: "chromium",
        detectedExecutablePath: "/usr/bin/chromium",
        detectError: null,
        userDataDir: "/tmp/openclaw",
        color: "#FF4500",
        headless: false,
        noSandbox: false,
        executablePath: null,
        attachOnly: false,
      },
    });

    expect(report.ok).toBe(true);
    const websocketCheck = report.checks.find((check) => check.id === "cdp-websocket");
    expect(websocketCheck?.status).toBe("info");
    expect(websocketCheck?.summary).toBe("Browser is launchable but not running");
  });

  it("fails when Chrome MCP attach is not ready", () => {
    const report = buildBrowserDoctorReport({
      status: {
        enabled: true,
        profile: "user",
        driver: "existing-session",
        transport: "chrome-mcp",
        running: false,
        cdpReady: false,
        cdpHttp: false,
        pid: null,
        cdpPort: null,
        cdpUrl: null,
        chosenBrowser: null,
        detectedBrowser: null,
        detectedExecutablePath: null,
        detectError: null,
        userDataDir: null,
        color: "#00AA00",
        headless: false,
        noSandbox: false,
        executablePath: null,
        attachOnly: true,
      },
    });

    expect(report.ok).toBe(false);
    const attachCheck = report.checks.find((check) => check.id === "attach-target");
    expect(attachCheck?.status).toBe("fail");
  });

  it("keeps managed launch warnings non-fatal", () => {
    const report = buildBrowserDoctorReport({
      platform: "linux",
      env: {},
      uid: 0,
      status: {
        enabled: true,
        profile: "openclaw",
        driver: "openclaw",
        transport: "cdp",
        running: false,
        cdpReady: false,
        cdpHttp: false,
        pid: null,
        cdpPort: 18800,
        cdpUrl: "http://127.0.0.1:18800",
        chosenBrowser: null,
        detectedBrowser: null,
        detectedExecutablePath: null,
        detectError: null,
        userDataDir: "/tmp/openclaw",
        color: "#FF4500",
        headless: false,
        headlessSource: "config",
        noSandbox: false,
        executablePath: null,
        attachOnly: false,
      },
    });

    expect(report.ok).toBe(true);
    expect(collectWarningCheckIds(report.checks)).toEqual([
      "managed-executable",
      "display",
      "linux-sandbox",
    ]);
    const displayCheck = report.checks.find((check) => check.id === "display");
    expect(displayCheck?.summary).toBe(
      "No DISPLAY or WAYLAND_DISPLAY is set while headed mode is selected (config)",
    );
  });

  it("reports Linux no-display fallback without a display warning", () => {
    const report = buildBrowserDoctorReport({
      platform: "linux",
      env: {},
      uid: 1000,
      status: {
        enabled: true,
        profile: "openclaw",
        driver: "openclaw",
        transport: "cdp",
        running: false,
        cdpReady: false,
        cdpHttp: false,
        pid: null,
        cdpPort: 18800,
        cdpUrl: "http://127.0.0.1:18800",
        chosenBrowser: null,
        detectedBrowser: "chrome",
        detectedExecutablePath: "/usr/bin/google-chrome-stable",
        detectError: null,
        userDataDir: "/tmp/openclaw",
        color: "#FF4500",
        headless: true,
        headlessSource: "linux-display-fallback",
        noSandbox: false,
        executablePath: null,
        attachOnly: false,
      },
    });

    const headlessCheck = report.checks.find((check) => check.id === "headless-mode");
    expect(headlessCheck?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "display")).toBeUndefined();
  });
});
