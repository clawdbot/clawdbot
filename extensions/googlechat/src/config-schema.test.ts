import { GoogleChatConfigSchema } from "openclaw/plugin-sdk/googlechat";
import { describe, expect, it } from "vitest";

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
});
