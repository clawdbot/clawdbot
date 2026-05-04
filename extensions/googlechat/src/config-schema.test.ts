import { describe, expect, it } from "vitest";
import { GoogleChatConfigSchema } from "../runtime-api.js";

describe("googlechat config schema", () => {
  it("accepts serviceAccount refs", () => {
    const result = GoogleChatConfigSchema.safeParse({
      serviceAccountRef: {
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
});
