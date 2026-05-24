import { describe, expect, it } from "vitest";
import { resolveLoginProfiles } from "./auth.js";

describe("resolveLoginProfiles", () => {
  it("returns original profiles when --profile-id is not provided", () => {
    const profiles = [
      {
        profileId: "openai-codex:default",
        credential: {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      },
    ];

    const resolved = resolveLoginProfiles({
      result: { profiles },
    });

    expect(resolved).toEqual(profiles);
  });

  it("overrides profile id when exactly one profile is returned", () => {
    const resolved = resolveLoginProfiles({
      requestedProfileId: "openai-codex:work",
      result: {
        profiles: [
          {
            profileId: "openai-codex:default",
            credential: {
              type: "oauth" as const,
              provider: "openai-codex",
              access: "a",
              refresh: "r",
              expires: Date.now() + 60_000,
            },
          },
        ],
      },
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.profileId).toBe("openai-codex:work");
  });

  it("throws when --profile-id is used with multi-profile auth responses", () => {
    expect(() =>
      resolveLoginProfiles({
        requestedProfileId: "provider:manual",
        result: {
          profiles: [
            {
              profileId: "provider:one",
              credential: { type: "api_key" as const, provider: "provider", key: "k1" },
            },
            {
              profileId: "provider:two",
              credential: { type: "api_key" as const, provider: "provider", key: "k2" },
            },
          ],
        },
      }),
    ).toThrow(/--profile-id requires exactly one returned auth profile/i);
  });
});
