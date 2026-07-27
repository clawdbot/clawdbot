// Mattermost tests cover group mentions plugin behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveMattermostGroupRequireMention } from "./group-mentions.js";

describe("resolveMattermostGroupRequireMention", () => {
  it("defaults to requiring mention when no override is configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {},
      },
    };

    const requireMention = resolveMattermostGroupRequireMention({ cfg, accountId: "default" });
    expect(requireMention).toBe(true);
  });

  it("lets groups config beat chatmode and chatmode beat the final default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groups: {
            calls: { requireMention: true },
          },
        },
      },
    };

    expect(
      resolveMattermostGroupRequireMention({ cfg, accountId: "default", groupId: "calls" }),
    ).toBe(true);
    expect(
      resolveMattermostGroupRequireMention({ cfg, accountId: "default", groupId: "other" }),
    ).toBe(false);
  });

  it("prefers an explicit runtime override when provided", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "oncall",
        },
      },
    };

    const requireMention = resolveMattermostGroupRequireMention({
      cfg,
      accountId: "default",
      requireMentionOverride: false,
    });
    expect(requireMention).toBe(false);
  });
});
