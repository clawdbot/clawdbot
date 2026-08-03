// Matrix tests cover group mentions plugin behavior.
import { describe, expect, it } from "vitest";
import {
  resolveMatrixGroupRequireMention,
  resolveMatrixGroupToolPolicy,
} from "./group-mentions.js";

describe("Matrix group policy", () => {
  it("resolves room tool policy from the case-preserved Matrix room id", () => {
    const policy = resolveMatrixGroupToolPolicy({
      accountId: "default",
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                groups: {
                  "!RoomABC:example.org": {
                    tools: { allow: ["sessions_spawn"] },
                  },
                },
              },
            },
          },
        },
      },
      groupId: "!roomabc:example.org",
      groupChannel: "!RoomABC:example.org",
    });

    expect(policy).toEqual({ allow: ["sessions_spawn"] });
  });

  it("keeps wildcard fields hidden by a matched whole entry", () => {
    const params = {
      accountId: "default",
      cfg: {
        channels: {
          matrix: {
            groups: {
              "!room:example.org": {},
              "*": { requireMention: false, tools: { deny: ["exec"] } },
            },
          },
        },
      },
      groupId: "!room:example.org",
    };

    expect(resolveMatrixGroupRequireMention(params)).toBe(true);
    expect(resolveMatrixGroupToolPolicy(params)).toBeUndefined();
  });

  it("projects autoReply ahead of requireMention", () => {
    const cfg = {
      channels: {
        matrix: {
          rooms: {
            "!auto:example.org": { autoReply: true, requireMention: true },
            "!manual:example.org": { autoReply: false, requireMention: false },
          },
        },
      },
    };

    expect(resolveMatrixGroupRequireMention({ cfg, groupId: "!auto:example.org" })).toBe(false);
    expect(resolveMatrixGroupRequireMention({ cfg, groupId: "!manual:example.org" })).toBe(true);
  });
});
