import { describe, expect, it } from "vitest";
import {
  formatGatewayServiceDescription,
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SYSTEMD_SERVICE_NAME,
  GATEWAY_WINDOWS_TASK_NAME,
  resolveGatewayLaunchAgentLabel,
  resolveGatewayProfileSuffix,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "./constants.js";

describe("resolveGatewayLaunchAgentLabel", () => {
  it("returns default label when no profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel();
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
    expect(result).toBe("bot.molt.gateway");
  });

  it("returns default label when profile is undefined", () => {
    const result = resolveGatewayLaunchAgentLabel(undefined);
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });

  it("returns default label when profile is 'default'", () => {
    const result = resolveGatewayLaunchAgentLabel("default");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });

  it("returns default label when profile is 'Default' (case-insensitive)", () => {
    const result = resolveGatewayLaunchAgentLabel("Default");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });

  it("returns profile-specific label when profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel("dev");
    expect(result).toBe("bot.molt.dev");
  });

  it("returns profile-specific label for custom profile", () => {
    const result = resolveGatewayLaunchAgentLabel("work");
    expect(result).toBe("bot.molt.work");
  });

  it("trims whitespace from profile", () => {
    const result = resolveGatewayLaunchAgentLabel("  staging  ");
    expect(result).toBe("bot.molt.staging");
  });

  it("returns default label for empty string profile", () => {
    const result = resolveGatewayLaunchAgentLabel("");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });

  it("returns default label for whitespace-only profile", () => {
    const result = resolveGatewayLaunchAgentLabel("   ");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });
});

describe("resolveGatewaySystemdServiceName", () => {
  it("returns default service name when no profile is set", () => {
    const result = resolveGatewaySystemdServiceName();
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
    expect(result).toBe("moltbot-gateway");
  });

  it("returns default service name when profile is undefined", () => {
    const result = resolveGatewaySystemdServiceName(undefined);
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });

  it("returns default service name when profile is 'default'", () => {
    const result = resolveGatewaySystemdServiceName("default");
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });

  it("returns default service name when profile is 'DEFAULT' (case-insensitive)", () => {
    const result = resolveGatewaySystemdServiceName("DEFAULT");
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });

  it("returns profile-specific service name when profile is set", () => {
    const result = resolveGatewaySystemdServiceName("dev");
    expect(result).toBe("moltbot-gateway-dev");
  });

  it("returns profile-specific service name for custom profile", () => {
    const result = resolveGatewaySystemdServiceName("production");
    expect(result).toBe("moltbot-gateway-production");
  });

  it("trims whitespace from profile", () => {
    const result = resolveGatewaySystemdServiceName("  test  ");
    expect(result).toBe("moltbot-gateway-test");
  });

  it("returns default service name for empty string profile", () => {
    const result = resolveGatewaySystemdServiceName("");
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });

  it("returns default service name for whitespace-only profile", () => {
    const result = resolveGatewaySystemdServiceName("   ");
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });
});

describe("resolveGatewayWindowsTaskName", () => {
  it("returns default task name when no profile is set", () => {
    const result = resolveGatewayWindowsTaskName();
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
    expect(result).toBe("Moltbot Gateway");
  });

  it("returns default task name when profile is undefined", () => {
    const result = resolveGatewayWindowsTaskName(undefined);
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
  });

  it("returns default task name when profile is 'default'", () => {
    const result = resolveGatewayWindowsTaskName("default");
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
  });

  it("returns default task name when profile is 'DeFaUlT' (case-insensitive)", () => {
    const result = resolveGatewayWindowsTaskName("DeFaUlT");
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
  });

  it("returns profile-specific task name when profile is set", () => {
    const result = resolveGatewayWindowsTaskName("dev");
    expect(result).toBe("Moltbot Gateway (dev)");
  });

  it("returns profile-specific task name for custom profile", () => {
    const result = resolveGatewayWindowsTaskName("work");
    expect(result).toBe("Moltbot Gateway (work)");
  });

  it("trims whitespace from profile", () => {
    const result = resolveGatewayWindowsTaskName("  ci  ");
    expect(result).toBe("Moltbot Gateway (ci)");
  });

  it("returns default task name for empty string profile", () => {
    const result = resolveGatewayWindowsTaskName("");
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
  });

  it("returns default task name for whitespace-only profile", () => {
    const result = resolveGatewayWindowsTaskName("   ");
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
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
    expect(formatGatewayServiceDescription()).toBe("Moltbot Gateway");
  });

  it("includes profile when set", () => {
    expect(formatGatewayServiceDescription({ profile: "work" })).toBe(
      "Moltbot Gateway (profile: work)",
    );
  });

  it("includes version when set", () => {
    expect(formatGatewayServiceDescription({ version: "2026.1.10" })).toBe(
      "Moltbot Gateway (v2026.1.10)",
    );
  });

  it("includes profile and version when set", () => {
    expect(formatGatewayServiceDescription({ profile: "dev", version: "1.2.3" })).toBe(
      "Moltbot Gateway (profile: dev, v1.2.3)",
    );
  });
});
