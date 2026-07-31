import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { resolveChannelImplicitMentions } from "./implicit-mentions.js";
import { ChannelsSchema } from "./zod-schema.channels-config.js";

describe("ChannelsSchema implicit mentions", () => {
  it("accepts the strict shared default shape", () => {
    expect(
      ChannelsSchema.safeParse({
        defaults: {
          implicitMentions: {
            replyToBot: false,
            quotedBot: true,
            threadParticipation: false,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      ChannelsSchema.safeParse({
        defaults: { implicitMentions: { unknownKind: true } },
      }).success,
    ).toBe(false);
  });
});

describe("resolveChannelImplicitMentions", () => {
  it("preserves shipped behavior when no policy is configured", () => {
    expect(resolveChannelImplicitMentions({ cfg: {}, channel: "mattermost" })).toEqual({
      replyToBot: true,
      quotedBot: true,
      threadParticipation: true,
    });
  });

  it("merges each kind using account, channel, then defaults precedence", () => {
    const cfg = {
      channels: {
        defaults: {
          implicitMentions: {
            replyToBot: false,
            quotedBot: false,
            threadParticipation: true,
          },
        },
        mattermost: {
          implicitMentions: { replyToBot: true },
          accounts: {
            Work: {
              implicitMentions: {
                quotedBot: true,
                threadParticipation: false,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveChannelImplicitMentions({ cfg, channel: "mattermost", accountId: "work" }),
    ).toEqual({
      replyToBot: true,
      quotedBot: true,
      threadParticipation: false,
    });
    expect(
      resolveChannelImplicitMentions({ cfg, channel: "mattermost", accountId: "missing" }),
    ).toEqual({
      replyToBot: true,
      quotedBot: false,
      threadParticipation: true,
    });
  });
});
