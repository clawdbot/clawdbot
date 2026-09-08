// Browser tests cover doctor plugin behavior.
import { describe, expect, it } from "vitest";
import chromeExtensionManifest from "../../chrome-extension/manifest.json" with { type: "json" };
import { buildBrowserDoctorReport } from "./doctor.js";

const outdatedExtensionVersion = chromeExtensionManifest.version === "2.0.0" ? "1.0.0" : "2.0.0";
const equivalentExtensionVersion =
  chromeExtensionManifest.version.split(".").length < 4
    ? `${chromeExtensionManifest.version}.0`
    : chromeExtensionManifest.version.replace(/\.0$/, "");

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
    expect(report.checks.find((check) => check.id === "extension-version")).toBeUndefined();
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
    expect(report.checks.find((check) => check.id === "extension-version")).toBeUndefined();
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

  it.each([
    ["outdated", outdatedExtensionVersion, "warn"],
    ["current", chromeExtensionManifest.version, "pass"],
    ["equivalent missing version component", equivalentExtensionVersion, "pass"],
    ["maximum valid version", "65535.65535.65535.65535", "warn"],
    ["unavailable", undefined, "info"],
    ["terminal-control input", "2.0.0\u001b[31m", "info"],
    ["oversized version component", "65536.0", "info"],
    ["nonzero leading zero", "02.0.0", "info"],
    ["all-zero version", "0.0.0.0", "info"],
    ["too many version components", "2.0.0.0.0", "info"],
  ] as const)("classifies %s extension version evidence", (_label, extensionVersion, severity) => {
    const report = buildBrowserDoctorReport({
      status: {
        enabled: true,
        profile: "chrome",
        driver: "extension",
        transport: "extension",
        running: true,
        pid: null,
        cdpPort: 18792,
        chosenBrowser: null,
        userDataDir: null,
        color: "#00AA00",
        headless: false,
        attachOnly: true,
      },
      extensionVersion,
    });

    const versionCheck = report.checks.find((check) => check.id === "extension-version");
    expect(versionCheck?.status).toBe(severity);
    if (severity === "warn") {
      expect(versionCheck?.summary).toContain(
        `running ${extensionVersion}; bundled ${chromeExtensionManifest.version}`,
      );
      expect(versionCheck?.fixHint).toMatch(/reload/i);
    } else {
      expect(versionCheck?.fixHint).toBeUndefined();
      expect(versionCheck?.summary).not.toContain("\u001b");
    }
    expect(report.ok).toBe(true);
  });
});
