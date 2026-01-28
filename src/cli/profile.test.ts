import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "moltbot",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "moltbot", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--dev", "gateway"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "moltbot", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--profile", "work", "status"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "moltbot", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--profile", "work", "--dev", "status"]);
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
    expect(env.CLAWDBOT_CONFIG_PATH).toBe(path.join(expectedStateDir, "moltbot.json"));
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
    expect(env.CLAWDBOT_CONFIG_PATH).toBe(path.join("/custom", "moltbot.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("moltbot doctor --fix", {})).toBe("moltbot doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "default" })).toBe(
      "moltbot doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "Default" })).toBe(
      "moltbot doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "bad profile" })).toBe(
      "moltbot doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("moltbot --profile work doctor --fix", { CLAWDBOT_PROFILE: "work" }),
    ).toBe("moltbot --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("moltbot --dev doctor", { CLAWDBOT_PROFILE: "dev" })).toBe(
      "moltbot --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "work" })).toBe(
      "moltbot --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "  jbclawd  " })).toBe(
      "moltbot --profile jbclawd doctor --fix",
    );
  });

  it("handles command with no args after moltbot", () => {
    expect(formatCliCommand("moltbot", { CLAWDBOT_PROFILE: "test" })).toBe(
      "moltbot --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm moltbot doctor", { CLAWDBOT_PROFILE: "work" })).toBe(
      "pnpm moltbot --profile work doctor",
    );
  });
});
