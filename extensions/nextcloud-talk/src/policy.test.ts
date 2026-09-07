// Nextcloud Talk tests cover group policy plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveNextcloudTalkGroupRequireMention,
  resolveNextcloudTalkGroupToolPolicy,
} from "./policy.js";

describe("nextcloud-talk group policy", () => {
  it("keeps exact mention matching separate from slug-matched tools", () => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          rooms: {
            "team-room": {
              requireMention: false,
              tools: { allow: ["sessions.list"] },
            },
            "*": { requireMention: true, tools: { deny: ["exec"] } },
          },
        },
      },
    } as OpenClawConfig;
    const params = { cfg, groupId: "Team Room" };

    expect(resolveNextcloudTalkGroupRequireMention(params)).toBe(true);
    expect(resolveNextcloudTalkGroupToolPolicy(params)).toEqual({
      allow: ["sessions.list"],
    });
  });

  it("falls through to wildcard fields when the exact room field is unset", () => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          rooms: {
            "team-room": {},
            "*": { requireMention: false, tools: { deny: ["exec"] } },
          },
        },
      },
    } as OpenClawConfig;
    const params = { cfg, groupId: "team-room" };

    expect(resolveNextcloudTalkGroupRequireMention(params)).toBe(false);
    expect(resolveNextcloudTalkGroupToolPolicy(params)).toEqual({ deny: ["exec"] });
  });
});
