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
});
