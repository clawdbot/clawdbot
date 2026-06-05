// Daemon constant tests cover platform constants used by service installers.
import { describe, expect, it } from "vitest";
import {
  formatGatewayServiceDescription,
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SYSTEMD_SERVICE_NAME,
  GATEWAY_WINDOWS_TASK_NAME,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  normalizeGatewayProfile,
  resolveGatewayLaunchAgentLabel,
  resolveGatewayProfileSuffix,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "./constants.js";

describe("normalizeGatewayProfile", () => {
  it("returns null for empty/default profiles", () => {
    expect(normalizeGatewayProfile()).toBeNull();
    expect(normalizeGatewayProfile("")).toBeNull();
    expect(normalizeGatewayProfile("   ")).toBeNull();
    expect(normalizeGatewayProfile("default")).toBeNull();
    expect(normalizeGatewayProfile(" Default ")).toBeNull();
  });

  it("returns trimmed custom profiles", () => {
    expect(normalizeGatewayProfile("dev")).toBe("dev");
    expect(normalizeGatewayProfile("  staging  ")).toBe("staging");
  });
});

describe("resolveGatewayLaunchAgentLabel", () => {
  it("returns default label when no profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel();
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
    expect(result).toBe("ai.openclaw.gateway");
  });

  it("returns profile-specific label when profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel("dev");
    expect(result).toBe("ai.openclaw.dev");
  });
});

describe("resolveGatewaySystemdServiceName", () => {
  it("returns default service name when no profile is set", () => {
    const result = resolveGatewaySystemdServiceName();
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
    expect(result).toBe("openclaw-gateway");
  });

  it("returns profile-specific service name when profile is set", () => {
    const result = resolveGatewaySystemdServiceName("dev");
    expect(result).toBe("openclaw-gateway-dev");
  });
});

describe("resolveGatewayWindowsTaskName", () => {
  it("returns default task name when no profile is set", () => {
    const result = resolveGatewayWindowsTaskName();
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
    expect(result).toBe("OpenClaw Gateway");
  });

  it("returns profile-specific task name when profile is set", () => {
    const result = resolveGatewayWindowsTaskName("dev");
    expect(result).toBe("OpenClaw Gateway (dev)");
  });
});

describe("resolveGatewayProfileSuffix", () => {
  it("returns empty string when no profile is set", () => {
    expect(resolveGatewayProfileSuffix()).toBe("");
  });

  it("returns empty string for default profiles", () => {
    expect(resolveGatewayProfileSuffix("default")).toBe("");
    expect(resolveGatewayProfileSuffix(" Default ")).toBe("");
  });

  it("returns a hyphenated suffix for custom profiles", () => {
    expect(resolveGatewayProfileSuffix("dev")).toBe("-dev");
  });

  it("trims whitespace from profiles", () => {
    expect(resolveGatewayProfileSuffix("  staging  ")).toBe("-staging");
  });
});

describe("formatGatewayServiceDescription", () => {
  it("returns default description when no profile/version", () => {
    expect(formatGatewayServiceDescription()).toBe("OpenClaw Gateway");
  });

  it("includes profile when set", () => {
    expect(formatGatewayServiceDescription({ profile: "work" })).toBe(
      "OpenClaw Gateway (profile: work)",
    );
  });

  it("includes version when set", () => {
    expect(formatGatewayServiceDescription({ version: "2026.1.10" })).toBe(
      "OpenClaw Gateway (v2026.1.10)",
    );
  });

  it("includes profile and version when set", () => {
    expect(formatGatewayServiceDescription({ profile: "dev", version: "1.2.3" })).toBe(
      "OpenClaw Gateway (profile: dev, v1.2.3)",
    );
  });
});

describe("resolveGatewayServiceDescription", () => {
  it("prefers explicit description override", () => {
    expect(
      resolveGatewayServiceDescription({
        env: { OPENCLAW_PROFILE: "work", OPENCLAW_SERVICE_VERSION: "1.0.0" },
        description: "Custom",
      }),
    ).toBe("Custom");
  });

  it("resolves version from explicit environment map", () => {
    expect(
      resolveGatewayServiceDescription({
        env: { OPENCLAW_PROFILE: "work", OPENCLAW_SERVICE_VERSION: "local" },
        environment: { OPENCLAW_SERVICE_VERSION: "remote" },
      }),
    ).toBe("OpenClaw Gateway (profile: work, vremote)");
  });
});

describe("LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES", () => {
  it("includes known pre-rebrand gateway unit names", () => {
    expect(LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES).toContain("clawdbot-gateway");
  });
});
