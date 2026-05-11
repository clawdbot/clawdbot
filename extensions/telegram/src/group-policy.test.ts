import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";

describe("resolveTelegramGroupRequireMention", () => {
  it("prefers topic overrides before group defaults", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              requireMention: true,
              tools: { allow: ["message.send"] },
              topics: {
                "77": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveTelegramGroupRequireMention({
        cfg,
        groupId: "-1001:topic:77",
      }),
    ).toBe(false);
  });
});

describe("resolveTelegramGroupToolPolicy", () => {
  it("uses chat-level tool policy for topic conversation ids", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveTelegramGroupToolPolicy({
        cfg,
        groupId: "-1001:topic:77",
      }),
    ).toEqual({ allow: ["message.send"] });
  });
});
