import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("strips --dev anywhere in argv", () => {
    const res = parseCliProfileArgs([
      "node",
      "clawdbot",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual([
      "node",
      "clawdbot",
      "gateway",
      "--allow-unconfigured",
    ]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs([
      "node",
      "clawdbot",
      "--profile",
      "work",
      "status",
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "clawdbot", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "clawdbot", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs([
      "node",
      "clawdbot",
      "--dev",
      "--profile",
      "work",
      "status",
    ]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs([
      "node",
      "clawdbot",
      "--profile",
      "work",
      "--dev",
      "status",
    ]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join("/home/peter", ".clawdbot-dev");
    expect(env.CLAWDBOT_PROFILE).toBe("dev");
    expect(env.CLAWDBOT_STATE_DIR).toBe(expectedStateDir);
    expect(env.CLAWDBOT_CONFIG_PATH).toBe(
      path.join(expectedStateDir, "clawdbot.json"),
    );
    expect(env.CLAWDBOT_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      CLAWDBOT_STATE_DIR: "/custom",
      CLAWDBOT_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.CLAWDBOT_STATE_DIR).toBe("/custom");
    expect(env.CLAWDBOT_GATEWAY_PORT).toBe("19099");
    expect(env.CLAWDBOT_CONFIG_PATH).toBe(
      path.join("/custom", "clawdbot.json"),
    );
  });
});
