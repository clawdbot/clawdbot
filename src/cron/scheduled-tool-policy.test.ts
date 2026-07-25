import { describe, expect, it } from "vitest";
import {
  createAccountCronScheduledToolPolicy,
  normalizeCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
} from "./scheduled-tool-policy.js";

describe("cron scheduled tool policy", () => {
  it("accepts only the closed current version", () => {
    expect(normalizeCronScheduledToolPolicy({ version: 1, mode: "trusted" })).toEqual({
      version: 1,
      mode: "trusted",
    });
    expect(normalizeCronScheduledToolPolicy({ version: 2, mode: "trusted" })).toBeUndefined();
    expect(
      normalizeCronScheduledToolPolicy({ version: 1, mode: "trusted", ownerAccountId: "work" }),
    ).toBeUndefined();
  });

  it("requires account provenance to match the persisted owner", () => {
    const policy = createAccountCronScheduledToolPolicy({
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
    expect(
      resolveCronScheduledToolPolicy({
        toolsAllow: ["write"],
        scheduledToolPolicy: policy,
        owner: {
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
      }),
    ).toEqual(policy);
    expect(
      resolveCronScheduledToolPolicy({
        toolsAllow: ["write"],
        scheduledToolPolicy: policy,
        owner: {
          sessionKey: "agent:main:discord:group:ops",
          accountId: "personal",
        },
      }),
    ).toBeUndefined();
  });
});
