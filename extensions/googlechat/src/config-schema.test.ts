// Googlechat tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { GoogleChatConfigSchema } from "../runtime-api.js";

describe("googlechat config schema", () => {
  it("accepts inline serviceAccount refs", () => {
    const result = GoogleChatConfigSchema.safeParse({
      serviceAccount: {
        source: "file",
        provider: "filemain",
        id: "/channels/googlechat/serviceAccount",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts the documented group config shape", () => {
    const result = GoogleChatConfigSchema.safeParse({
      groups: {
        "spaces/AAAA": {
          enabled: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts canonical DM access and shared runtime messaging knobs", () => {
    const result = GoogleChatConfigSchema.safeParse({
      dmPolicy: "allowlist",
      allowFrom: ["users/1234567890"],
      markdown: { tables: "bullets" },
      heartbeatVisibility: { showOk: false },
      contextVisibility: "allowlist_quote",
    });

    expect(result.success).toBe(true);
  });

  it("rejects legacy nested DM access keys", () => {
    const result = GoogleChatConfigSchema.safeParse({ dm: { policy: "pairing" } });

    expect(result.success).toBe(false);
  });
});
