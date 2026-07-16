import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordConfigSchema } from "../../config-api.js";
import { mergeDiscordAccountConfig } from "../accounts.js";
import { resolveActivityUserAuthorized } from "./allowlist.js";
import { resolveDiscordActivitiesConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Discord Activities config", () => {
  it("accepts the strict activities block", () => {
    const parsed = DiscordConfigSchema.safeParse({
      activities: { clientSecret: "secret", applicationId: "123456789012345678" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-snowflake Activity application ID", () => {
    const parsed = DiscordConfigSchema.safeParse({
      activities: { clientSecret: "secret", applicationId: "abc" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown activities keys", () => {
    const parsed = DiscordConfigSchema.safeParse({
      activities: { clientSecret: "secret", publicUrl: "https://example.com" },
    });
    expect(parsed.success).toBe(false);
  });

  it("resolves config and environment secrets only when the block exists", () => {
    expect(resolveDiscordActivitiesConfig({})).toEqual({
      enabled: false,
      reason: "not-configured",
    });
    expect(resolveDiscordActivitiesConfig({ activities: {} }, {})).toEqual({
      enabled: false,
      reason: "missing-client-secret",
    });
    expect(
      resolveDiscordActivitiesConfig(
        { activities: { applicationId: "123" } },
        { DISCORD_CLIENT_SECRET: "envsec" },
      ),
    ).toEqual({ enabled: true, clientSecret: "envsec", applicationId: "123" });
    expect(
      resolveDiscordActivitiesConfig(
        { activities: { clientSecret: "cfgsec" } },
        { DISCORD_CLIENT_SECRET: "envsec" },
      ),
    ).toEqual({ enabled: true, clientSecret: "cfgsec" });
  });

  it("merges root Activity credentials with account-specific application IDs", () => {
    const account = mergeDiscordAccountConfig(
      {
        channels: {
          discord: {
            activities: { clientSecret: "rootsec" },
            accounts: { work: { activities: { applicationId: "123" } } },
          },
        },
      },
      "work",
    );
    expect(account.activities).toEqual({ clientSecret: "rootsec", applicationId: "123" });
  });
});

describe("Discord Activity user authorization", () => {
  it("always matches IDs but gates username matching behind the dangerous opt-in", () => {
    expect(
      resolveActivityUserAuthorized({ allowFrom: ["42"] }, { id: "42", username: "alice" }),
    ).toBe(true);
    expect(
      resolveActivityUserAuthorized(
        { dm: { allowFrom: ["alice"] } },
        { id: "99", username: "Alice" },
      ),
    ).toBe(false);
    expect(
      resolveActivityUserAuthorized(
        { dangerouslyAllowNameMatching: true, dm: { allowFrom: ["alice"] } },
        { id: "99", username: "Alice" },
      ),
    ).toBe(true);
  });

  it("allows an empty allowlist only for open DMs", () => {
    expect(resolveActivityUserAuthorized({ dmPolicy: "open" }, { id: "42" })).toBe(true);
    expect(resolveActivityUserAuthorized({}, { id: "42" })).toBe(false);
  });
});
