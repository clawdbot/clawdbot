import { describe, expect, it } from "vitest";
import {
  createAccountCronScheduledToolPolicy,
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  normalizeCronToolsAllowExecTarget,
  normalizeCronToolsAllowExecTargetRequirement,
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

  it("does not treat inherited authority fields as authored", () => {
    expect(normalizeCronScheduledToolCallerOrigin(Object.create({ kind: "local" }))).toEqual({
      kind: "unknown",
    });
    expect(
      normalizeCronScheduledToolPolicy(Object.create({ version: 1, mode: "trusted" })),
    ).toBeUndefined();
    expect(
      normalizeCronToolsAllowExecTarget(Object.create({ version: 1, host: "gateway" })),
    ).toBeUndefined();
    expect(
      normalizeCronToolsAllowExecTargetRequirement(
        Object.create({
          version: 1,
          target: { version: 1, host: "gateway" },
          grantIndex: 0,
        }),
      ),
    ).toEqual({ version: 1, recoveryRequired: true });
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
