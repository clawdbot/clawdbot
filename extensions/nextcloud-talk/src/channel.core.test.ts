// Nextcloud Talk tests cover channel.core plugin behavior.
import { describe, expect, it } from "vitest";
import {
  nextcloudTalkConfigAdapter,
  nextcloudTalkPairingTextAdapter,
  nextcloudTalkSecurityAdapter,
} from "./channel.adapters.js";
import { NextcloudTalkChannelConfigSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";

function safeParseNextcloudTalkConfig(value: unknown) {
  const runtime = NextcloudTalkChannelConfigSchema.runtime;
  if (!runtime) {
    throw new Error("Nextcloud Talk runtime config schema is unavailable");
  }
  return runtime.safeParse(value);
}

describe("nextcloud talk channel core", () => {
  it.each([
    {
      label: "omitted media allowlist",
      input: {},
      expected: {},
      expectOmitted: true,
    },
    {
      label: "explicit sender",
      input: { mediaAllowFrom: ["users/alice"] },
      expected: { mediaAllowFrom: ["users/alice"] },
    },
    {
      label: "wildcard",
      input: { mediaAllowFrom: ["*"] },
      expected: { mediaAllowFrom: ["*"] },
    },
    {
      label: "named account with size override",
      input: {
        mediaAllowFrom: ["users/alice"],
        mediaMaxMb: 20,
        accounts: {
          work: { mediaAllowFrom: ["*"], mediaMaxMb: 5 },
        },
      },
      expected: {
        mediaAllowFrom: ["users/alice"],
        mediaMaxMb: 20,
        accounts: {
          work: { mediaAllowFrom: ["*"], mediaMaxMb: 5 },
        },
      },
    },
  ])(
    "accepts representative inbound media config: $label",
    ({ input, expected, expectOmitted }) => {
      const result = safeParseNextcloudTalkConfig(input);
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(JSON.stringify(result.issues));
      }
      expect(result.data).toMatchObject(expected);
      if (expectOmitted) {
        expect(result.data).not.toHaveProperty("mediaAllowFrom");
        expect(result.data).not.toHaveProperty("mediaMaxMb");
      }
    },
  );

  it("accepts SecretRef botSecret and apiPassword at top-level", () => {
    const result = safeParseNextcloudTalkConfig({
      baseUrl: "https://cloud.example.com",
      botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_BOT_SECRET" },
      apiUser: "bot",
      apiPassword: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_API_PASSWORD" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botSecret and apiPassword on account", () => {
    const result = safeParseNextcloudTalkConfig({
      accounts: {
        main: {
          baseUrl: "https://cloud.example.com",
          botSecret: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_BOT_SECRET",
          },
          apiUser: "bot",
          apiPassword: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_API_PASSWORD",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("normalizes trimmed DM allowlist prefixes to lowercase ids", () => {
    const resolveDmPolicy = nextcloudTalkSecurityAdapter.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "secret",
          dmPolicy: "allowlist",
          allowFrom: ["  nc:User-Id  "],
        },
      },
    } as CoreConfig;

    const result = resolveDmPolicy({
      cfg,
      account: nextcloudTalkConfigAdapter.resolveAccount(cfg, "default"),
    });
    if (!result) {
      throw new Error("nextcloud-talk resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  nc:User-Id  "]);
    expect(result.normalizeEntry?.("  nc:User-Id  ")).toBe("user-id");
    expect(nextcloudTalkPairingTextAdapter.normalizeAllowEntry("  nextcloud-talk:User-Id  ")).toBe(
      "user-id",
    );
  });
});
