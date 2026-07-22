import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ConfigSchemaResponseSchema } from "./config.js";

const response = {
  schema: {},
  uiHints: {
    "channels.sms.fromNumber": {
      presentation: "phone-number",
    },
  },
  version: "1",
  generatedAt: "2026-07-20T00:00:00.000Z",
};

describe("ConfigSchemaResponseSchema", () => {
  it("accepts the phone-number presentation hint", () => {
    expect(Value.Check(ConfigSchemaResponseSchema, response)).toBe(true);
  });

  it("rejects unknown presentation hint values", () => {
    expect(
      Value.Check(ConfigSchemaResponseSchema, {
        ...response,
        uiHints: {
          "channels.sms.fromNumber": {
            presentation: "telephone",
          },
        },
      }),
    ).toBe(false);
  });
});
