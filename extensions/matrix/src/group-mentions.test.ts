import { describe, expect, it } from "vitest";
import { resolveMatrixGroupToolPolicy } from "./group-mentions.js";

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
});
