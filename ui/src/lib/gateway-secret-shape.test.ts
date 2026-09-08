import { describe, expect, it } from "vitest";
import { encodePairingSetupCode } from "../../../src/pairing/setup-code.js";
import { classifyGatewaySecret } from "./gateway-secret-shape.ts";

const setupCode = encodePairingSetupCode({
  url: "wss://gateway.example/日本語",
  bootstrapToken: "synthetic-bootstrap-token",
  expiresAtMs: 1,
});

describe("classifyGatewaySecret", () => {
  it.each([setupCode, `oc-pair://${setupCode}`, `  OC-PAIR://${setupCode}\n`])(
    "recognizes encoded setup payloads even after expiry",
    (value) => expect(classifyGatewaySecret(value)).toBe("setup-code"),
  );

  it.each([
    "",
    "   ",
    "ordinary-gateway-token",
    "a".repeat(43), // Device tokens cannot be distinguished from configured shared tokens.
    Buffer.from("random bytes, not JSON").toString("base64url"),
    "oc-pair://not-a-setup-code",
    ...[
      null,
      [],
      {},
      { url: "wss://gateway.example" },
      { bootstrapToken: "fake" },
      { url: "wss://gateway.example", bootstrapToken: 1 },
      { url: "", bootstrapToken: "fake" },
      { url: "wss://gateway.example", bootstrapToken: " " },
    ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")),
  ])("leaves unrelated or malformed values unknown", (value) => {
    expect(classifyGatewaySecret(value)).toBe("unknown");
  });
});
