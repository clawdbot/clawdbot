import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectMacGatewayPlatformWarnings,
  collectMacLaunchAgentOverrideWarning,
  collectMacLaunchctlGatewayEnvOverrideWarning,
  collectMacStaleOpenClawUpdateLaunchdJobsWarning,
  noteMacLaunchctlGatewayEnvOverrides,
  noteMacStaleOpenClawUpdateLaunchdJobs,
} from "./doctor-platform-notes.js";

function requireNoteCall(noteFn: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
  const call = noteFn.mock.calls[index];
  if (!call) {
    throw new Error(`expected note call ${index}`);
  }
  return call;
}

describe("noteMacLaunchctlGatewayEnvOverrides", () => {
  it("collects clear unsetenv instructions for token override", async () => {
    const getenv = vi.fn(async (name: string) =>
      name === "OPENCLAW_GATEWAY_TOKEN" ? "launchctl-token" : undefined,
    );
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as OpenClawConfig;

    const warning = await collectMacLaunchctlGatewayEnvOverrideWarning(cfg, {
      platform: "darwin",
      getenv,
    });

    expect(warning).toContain("Host-wide launchctl gateway auth overrides detected");
    expect(warning).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(warning).toContain("launchctl unsetenv OPENCLAW_GATEWAY_TOKEN");
    expect(warning).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
  });

  it("prints clear unsetenv instructions for token override", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async (name: string) =>
      name === "OPENCLAW_GATEWAY_TOKEN" ? "launchctl-token" : undefined,
    );
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(getenv).toHaveBeenCalledTimes(2);

    const [message, title] = requireNoteCall(noteFn);
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("Host-wide launchctl gateway auth overrides detected");
    expect(message).toContain("Current managed Gateway installs do not need these values");
    expect(message).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(message).toContain("launchctl unsetenv OPENCLAW_GATEWAY_TOKEN");
    expect(message).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
  });

  it("does nothing when config has no gateway credentials", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "launchctl-token");
    const cfg = {} as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("treats SecretRef-backed credentials as configured", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async (name: string) =>
      name === "OPENCLAW_GATEWAY_PASSWORD" ? "launchctl-password" : undefined,
    );
    const cfg = {
      gateway: {
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message] = requireNoteCall(noteFn);
    expect(message).toContain("OPENCLAW_GATEWAY_PASSWORD");
  });

  it("does nothing on non-darwin platforms", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "launchctl-token");
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "linux", getenv, noteFn });

    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });
});

describe("noteMacStaleOpenClawUpdateLaunchdJobs", () => {
  it("collects stale updater job cleanup guidance on macOS", async () => {
    const findJobs = vi.fn(async () => [
      {
        label: "ai.openclaw.update.2026.5.12",
        lastExitStatus: 127,
      },
      {
        label: "ai.openclaw.manual-update.1717168800",
        lastExitStatus: 0,
      },
    ]);
    const env = {
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
    } as NodeJS.ProcessEnv;

    const warning = await collectMacStaleOpenClawUpdateLaunchdJobsWarning({
      platform: "darwin",
      findJobs,
      env,
    });

    expect(findJobs).toHaveBeenCalledWith(env);
    expect(warning).toContain("Stale OpenClaw updater launchd job(s) detected");
    expect(warning).toContain("ai.openclaw.update.2026.5.12");
    expect(warning).toContain("ai.openclaw.manual-update.1717168800");
    expect(warning).toContain("launchctl remove <label>");
    expect(warning).toContain("openclaw gateway restart");
  });

  it("uses service env for gateway platform stale updater warnings", async () => {
    const serviceEnv = {
      OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
    };
    const service = {
      readCommand: vi.fn(async () => ({
        programArguments: ["/bin/node", "cli", "gateway"],
        environment: serviceEnv,
      })),
    };
    const findJobs = vi.fn(async () => []);

    await collectMacGatewayPlatformWarnings({} as OpenClawConfig, {
      platform: "darwin",
      service,
      findJobs,
    });

    expect(service.readCommand).toHaveBeenCalledTimes(1);
    expect(findJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
      }),
    );
  });

  it("uses service env for doctor stale updater notes", async () => {
    const serviceEnv = {
      OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
    };
    const service = {
      readCommand: vi.fn(async () => ({
        programArguments: ["/bin/node", "cli", "doctor"],
        environment: serviceEnv,
      })),
    };
    const findJobs = vi.fn(async () => []);

    await noteMacStaleOpenClawUpdateLaunchdJobs({
      platform: "darwin",
      service,
      findJobs,
    });

    expect(service.readCommand).toHaveBeenCalledTimes(1);
    expect(findJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
      }),
    );
  });

  it("prints stale updater job cleanup guidance on macOS", async () => {
    const noteFn = vi.fn();
    const service = {
      readCommand: vi.fn(async () => null),
    };
    const findJobs = vi.fn(async () => [
      {
        label: "ai.openclaw.update.2026.5.12",
        lastExitStatus: 127,
      },
      {
        label: "ai.openclaw.manual-update.1717168800",
        lastExitStatus: 0,
      },
    ]);

    await noteMacStaleOpenClawUpdateLaunchdJobs({
      platform: "darwin",
      service,
      findJobs,
      noteFn,
    });

    expect(findJobs).toHaveBeenCalledTimes(1);
    const [message, title] = requireNoteCall(noteFn);
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("Stale OpenClaw updater launchd job(s) detected");
    expect(message).toContain("ai.openclaw.update.2026.5.12");
    expect(message).toContain("ai.openclaw.manual-update.1717168800");
    expect(message).toContain("launchctl remove <label>");
    expect(message).toContain("openclaw gateway restart");
  });

  it("does nothing when no stale updater jobs exist", async () => {
    const noteFn = vi.fn();
    const service = {
      readCommand: vi.fn(async () => null),
    };
    const findJobs = vi.fn(async () => []);

    await noteMacStaleOpenClawUpdateLaunchdJobs({
      platform: "darwin",
      service,
      findJobs,
      noteFn,
    });

    expect(noteFn).not.toHaveBeenCalled();
  });
});

describe("collectMacLaunchAgentOverrideWarning", () => {
  it("collects guidance when launch agent writes are disabled", () => {
    const warning = collectMacLaunchAgentOverrideWarning({
      platform: "darwin",
      homeDir: "/Users/tester",
      exists: (candidate) => candidate.includes("disable-launchagent"),
    });

    expect(warning).toContain("LaunchAgent writes are disabled");
    expect(warning).toContain("rm ");
    expect(warning).toContain("disable-launchagent");
  });

  it("does nothing when launch agent writes are not disabled", () => {
    expect(
      collectMacLaunchAgentOverrideWarning({
        platform: "darwin",
        homeDir: "/Users/tester",
        exists: () => false,
      }),
    ).toBeNull();
  });
});
