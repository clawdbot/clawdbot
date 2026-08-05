// Browser tests cover doctor plugin behavior.
import { describe, expect, it } from "vitest";
import type { BrowserStatus } from "./client.types.js";
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

function createExtensionStatus(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    enabled: true,
    profile: "chrome",
    driver: "extension",
    transport: "extension",
    running: true,
    cdpReady: true,
    cdpHttp: true,
    pid: null,
    cdpPort: 18799,
    cdpUrl: "http://127.0.0.1:18799",
    chosenBrowser: null,
    detectedBrowser: null,
    detectedExecutablePath: null,
    detectError: null,
    userDataDir: null,
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    executablePath: null,
    attachOnly: true,
    ...overrides,
  };
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

  it("reports cached software graphics facts without failing doctor", () => {
    const report = buildBrowserDoctorReport({
      status: {
        enabled: true,
        profile: "openclaw",
        driver: "openclaw",
        transport: "cdp",
        running: true,
        cdpReady: true,
        cdpHttp: true,
        pid: 4321,
        cdpPort: 18800,
        cdpUrl: "http://127.0.0.1:18800",
        chosenBrowser: "chromium",
        detectedBrowser: "chromium",
        detectedExecutablePath: "/usr/bin/chromium",
        detectError: null,
        userDataDir: "/tmp/openclaw",
        color: "#FF4500",
        headless: true,
        noSandbox: false,
        executablePath: null,
        attachOnly: false,
        graphics: {
          status: "available",
          observedAt: 123,
          acceleration: "software",
          renderer: "ANGLE (Google, SwiftShader Device)",
          vendor: "Google Inc.",
          version: "OpenGL ES 3.0",
          backend: "(gl=angle,angle=swiftshader)",
          devices: [],
          featureStatus: { webgl: "enabled_readback" },
          disabledFeatures: [],
          driverBugWorkarounds: [],
          videoDecoding: [],
          videoEncoding: [],
        },
      },
    });

    expect(report.ok).toBe(true);
    const graphicsCheck = report.checks.find((check) => check.id === "graphics");
    expect(graphicsCheck?.status).toBe("info");
    expect(graphicsCheck?.summary).toContain("software");
    expect(graphicsCheck?.summary).toContain("SwiftShader");
  });

  it("warns when a running managed browser cannot provide graphics facts", () => {
    const report = buildBrowserDoctorReport({
      status: {
        enabled: true,
        profile: "openclaw",
        driver: "openclaw",
        transport: "cdp",
        running: true,
        cdpReady: true,
        cdpHttp: true,
        pid: 4321,
        cdpPort: 18800,
        cdpUrl: "http://127.0.0.1:18800",
        chosenBrowser: "chromium",
        detectedBrowser: "chromium",
        detectedExecutablePath: "/usr/bin/chromium",
        detectError: null,
        userDataDir: "/tmp/openclaw",
        color: "#FF4500",
        headless: true,
        noSandbox: false,
        executablePath: null,
        attachOnly: false,
        graphics: {
          status: "unavailable",
          observedAt: 123,
          reason: "SystemInfo domain unavailable",
        },
      },
    });

    expect(report.ok).toBe(true);
    const graphicsCheck = report.checks.find((check) => check.id === "graphics");
    expect(graphicsCheck).toMatchObject({
      status: "warn",
      summary: "unavailable: SystemInfo domain unavailable",
    });
  });

  it("passes when the running extension matches the bundled version", () => {
    const report = buildBrowserDoctorReport({
      status: createExtensionStatus({
        chromeExtension: {
          runningVersion: "2.1.0",
          bundledVersion: "2.1.0",
          versionState: "match",
        },
      }),
    });

    expect(report.checks.find((check) => check.id === "extension-version")).toMatchObject({
      status: "pass",
      summary: "running 2.1.0; bundled 2.1.0 (match)",
    });
  });

  it("warns with recovery guidance when extension versions differ", () => {
    const report = buildBrowserDoctorReport({
      status: createExtensionStatus({
        chromeExtension: {
          runningVersion: "2.0.0",
          bundledVersion: "2.1.0",
          versionState: "mismatch",
        },
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "extension-version")).toMatchObject({
      status: "warn",
      summary: "running 2.0.0; bundled 2.1.0 (mismatch)",
      fixHint: expect.stringContaining("chrome://extensions"),
    });
  });

  it("warns when a connected extension cannot report its version", () => {
    const report = buildBrowserDoctorReport({
      status: createExtensionStatus({
        chromeExtension: {
          runningVersion: null,
          bundledVersion: "2.1.0",
          versionState: "unavailable",
        },
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "extension-version")).toMatchObject({
      status: "warn",
      summary: "running unavailable; bundled 2.1.0 (unavailable)",
      fixHint: expect.stringContaining("Load unpacked"),
    });
  });

  it("reports an unavailable disconnected extension version as informational", () => {
    const report = buildBrowserDoctorReport({
      status: createExtensionStatus({
        running: false,
        chromeExtension: {
          runningVersion: null,
          bundledVersion: "2.1.0",
          versionState: "unavailable",
        },
      }),
    });

    expect(report.checks.find((check) => check.id === "extension-version")).toMatchObject({
      status: "info",
      summary: "running unavailable; bundled 2.1.0 (unavailable)",
    });
  });
});
