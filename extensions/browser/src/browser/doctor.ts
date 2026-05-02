import type { BrowserStatus, BrowserTransport } from "./client.types.js";

type BrowserDoctorCheckStatus = "pass" | "warn" | "fail" | "info";

export type BrowserDoctorCheck = {
  id: string;
  label: string;
  status: BrowserDoctorCheckStatus;
  summary: string;
  fixHint?: string;
};

export type BrowserDoctorReport = {
  ok: boolean;
  profile: string;
  transport: BrowserTransport;
  checks: BrowserDoctorCheck[];
  status: BrowserStatus;
};

export function buildBrowserDoctorReport(params: {
  status: BrowserStatus;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number;
}): BrowserDoctorReport {
  const status = params.status;
  const checks: BrowserDoctorCheck[] = [];
  const transport: BrowserTransport = status.transport === "chrome-mcp" ? "chrome-mcp" : "cdp";

  checks.push({
    id: "plugin-enabled",
    label: "Browser plugin",
    status: status.enabled ? "pass" : "fail",
    summary: status.enabled ? "enabled" : "disabled",
    ...(status.enabled ? {} : { fixHint: "Enable the browser plugin and restart the Gateway." }),
  });

  checks.push({
    id: "profile",
    label: "Profile",
    status: "pass",
    summary: `${status.profile ?? "openclaw"} via ${transport}`,
  });

  if (transport === "chrome-mcp") {
    checks.push({
      id: "attach-target",
      label: "Existing browser attach",
      status: status.running ? "pass" : "fail",
      summary: status.running
        ? "Chrome MCP target is reachable"
        : "Chrome MCP target is not reachable",
      ...(status.running
        ? {}
        : {
            fixHint:
              "Keep the matching Chromium browser running, enable remote debugging in chrome://inspect, and accept the attach prompt.",
          }),
    });
  } else {
    checks.push({
      id: "managed-executable",
      label: "Chromium executable",
      status: status.detectError ? "fail" : status.detectedExecutablePath ? "pass" : "warn",
      summary: status.detectError
        ? status.detectError
        : status.detectedExecutablePath
          ? `${status.detectedBrowser ?? "chromium"} at ${status.detectedExecutablePath}`
          : "No Chromium executable detected",
      ...(status.detectedExecutablePath || status.detectError
        ? {}
        : { fixHint: "Install Chrome/Chromium/Brave/Edge or set browser.executablePath." }),
    });

    const platform = params.platform ?? process.platform;
    const env = params.env ?? process.env;
    const uid = params.uid ?? process.getuid?.();
    const missingDisplay =
      platform === "linux" && !status.headless && !env.DISPLAY && !env.WAYLAND_DISPLAY;
    if (status.headlessSource === "linux-display-fallback") {
      checks.push({
        id: "headless-mode",
        label: "Headless mode",
        status: "pass",
        summary: "Linux no-display fallback selected headless mode",
      });
    }
    if (missingDisplay) {
      checks.push({
        id: "display",
        label: "Display",
        status: "warn",
        summary: `No DISPLAY or WAYLAND_DISPLAY is set while headed mode is selected (${status.headlessSource ?? "unknown"})`,
        fixHint:
          "Use a desktop session, Xvfb, set OPENCLAW_BROWSER_HEADLESS=1, or remove the headed override.",
      });
    }
    if (platform === "linux" && uid === 0 && !status.noSandbox) {
      checks.push({
        id: "linux-sandbox",
        label: "Linux sandbox",
        status: "warn",
        summary: "Gateway is running as root while browser.noSandbox is false",
        fixHint: "Set browser.noSandbox: true for container/root Chromium runtimes.",
      });
    }

    checks.push({
      id: "cdp-http",
      label: "CDP HTTP",
      status: status.cdpHttp ? "pass" : status.running ? "fail" : "info",
      summary: status.cdpHttp
        ? "CDP HTTP endpoint is reachable"
        : status.running
          ? "CDP HTTP endpoint is not reachable"
          : "Browser is not currently running",
      ...(status.cdpHttp || !status.running
        ? {}
        : {
            fixHint: "Run openclaw browser start or inspect browser.cdpUrl/CDP port reachability.",
          }),
    });

    checks.push({
      id: "cdp-websocket",
      label: "CDP WebSocket",
      status: status.cdpReady ? "pass" : status.running ? "fail" : "info",
      summary: status.cdpReady
        ? "CDP WebSocket is reachable"
        : status.running
          ? "CDP WebSocket is not reachable"
          : "Browser is launchable but not running",
      ...(status.cdpReady || !status.running
        ? {}
        : { fixHint: "Check Chrome launch logs, stale locks, proxy env, and port conflicts." }),
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    profile: status.profile ?? "openclaw",
    transport,
    checks,
    status,
  };
}
