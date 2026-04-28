import { describe, expect, it } from "vitest";
import {
  nextcloudTalkConfigAdapter,
  nextcloudTalkPairingTextAdapter,
  nextcloudTalkSecurityAdapter,
} from "./channel.adapters.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";

describe("nextcloud talk channel core", () => {
  it("accepts SecretRef botSecret and apiPassword at top-level", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      baseUrl: "https://cloud.example.com",
      botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_BOT_SECRET" },
      apiUser: "bot",
      apiPassword: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_API_PASSWORD" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botSecret and apiPassword on account", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
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
