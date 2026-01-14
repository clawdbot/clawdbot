import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../../config/config.js";
import type { GroupKeyResolution } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { resolveGroupRequireMention } from "./groups.js";

describe("resolveGroupRequireMention", () => {
  it("respects Discord guild/channel requireMention settings", () => {
    const cfg: ClawdbotConfig = {
      channels: {
        discord: {
          guilds: {
            "145": {
              requireMention: false,
              channels: {
                general: { allow: true },
              },
            },
          },
        },
      },
    };
    const ctx: TemplateContext = {
      Provider: "discord",
      From: "group:123",
      GroupRoom: "#general",
      GroupSpace: "145",
    };
    const groupResolution: GroupKeyResolution = {
      channel: "discord",
      id: "123",
      chatType: "group",
    };

    expect(resolveGroupRequireMention({ cfg, ctx, groupResolution })).toBe(
      false,
    );
  });

  it("respects Slack channel requireMention settings", () => {
    const cfg: ClawdbotConfig = {
      channels: {
        slack: {
          channels: {
            C123: { requireMention: false },
          },
        },
      },
    };
    const ctx: TemplateContext = {
      Provider: "slack",
      From: "slack:channel:C123",
      GroupSubject: "#general",
    };
    const groupResolution: GroupKeyResolution = {
      channel: "slack",
      id: "C123",
      chatType: "group",
    };

    expect(resolveGroupRequireMention({ cfg, ctx, groupResolution })).toBe(
      false,
    );
  });
});
