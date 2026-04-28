import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { inspectDiscordAccount } from "./account-inspect.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("inspectDiscordAccount", () => {
  it("prefers account token over channel token and strips Bot prefix", () => {
    const inspected = inspectDiscordAccount({
      cfg: asConfig({
        channels: {
          discord: {
            token: "Bot channel-token",
            accounts: {
              work: {
                token: "Bot account-token",
              },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(inspected.token).toBe("account-token");
    expect(inspected.tokenSource).toBe("config");
    expect(inspected.tokenStatus).toBe("available");
    expect(inspected.configured).toBe(true);
  });

  it("reports configured_unavailable for unresolved configured secret input", () => {
    const inspected = inspectDiscordAccount({
      cfg: asConfig({
        channels: {
          discord: {
            accounts: {
              work: {
                token: { source: "env", id: "DISCORD_TOKEN" },
              },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(inspected.token).toBe("");
    expect(inspected.tokenSource).toBe("config");
    expect(inspected.tokenStatus).toBe("configured_unavailable");
    expect(inspected.configured).toBe(true);
  });

  it("does not fall back when account token key exists but is missing", () => {
    const inspected = inspectDiscordAccount({
      cfg: asConfig({
        channels: {
          discord: {
            token: "Bot channel-token",
            accounts: {
              work: {
                token: "",
              },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(inspected.token).toBe("");
    expect(inspected.tokenSource).toBe("none");
    expect(inspected.tokenStatus).toBe("missing");
    expect(inspected.configured).toBe(false);
  });

  it("falls back to channel token when account token is absent", () => {
    const inspected = inspectDiscordAccount({
      cfg: asConfig({
        channels: {
          discord: {
            token: "Bot channel-token",
            accounts: {
              work: {},
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(inspected.token).toBe("channel-token");
    expect(inspected.tokenSource).toBe("config");
    expect(inspected.tokenStatus).toBe("available");
    expect(inspected.configured).toBe(true);
  });

  it("allows env token only for default account", () => {
    const defaultInspected = inspectDiscordAccount({
      cfg: asConfig({}),
      accountId: "default",
      envToken: "Bot env-default",
    });
    const namedInspected = inspectDiscordAccount({
      cfg: asConfig({
        channels: {
          discord: {
            accounts: {
              work: {},
            },
          },
        },
      }),
      accountId: "work",
      envToken: "Bot env-work",
    });

    expect(defaultInspected.token).toBe("env-default");
    expect(defaultInspected.tokenSource).toBe("env");
    expect(defaultInspected.configured).toBe(true);
    expect(namedInspected.token).toBe("");
    expect(namedInspected.tokenSource).toBe("none");
    expect(namedInspected.configured).toBe(false);
  });
});
