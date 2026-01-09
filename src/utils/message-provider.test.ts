import { describe, expect, it } from "vitest";

import { resolveGatewayMessageProvider } from "./message-provider.js";

describe("message-provider", () => {
  it("normalizes gateway message providers and rejects unknown values", () => {
    expect(resolveGatewayMessageProvider("discord")).toBe("discord");
    expect(resolveGatewayMessageProvider(" imsg ")).toBe("imessage");
    expect(resolveGatewayMessageProvider("teams")).toBe("msteams");
    expect(resolveGatewayMessageProvider("web")).toBe("whatsapp");
    expect(resolveGatewayMessageProvider("nope")).toBeUndefined();
  });
});
