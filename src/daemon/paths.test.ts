import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".clawdbot"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".clawdbot-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".clawdbot"));
  });

  it("uses CLAWDBOT_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_STATE_DIR: "/var/lib/moltbot" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/moltbot"));
  });

  it("expands ~ in CLAWDBOT_STATE_DIR", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_STATE_DIR: "~/moltbot-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/moltbot-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { CLAWDBOT_STATE_DIR: "C:\\State\\moltbot" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\moltbot");
  });
});
