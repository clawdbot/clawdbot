// Shared contract tests run in Node using only the browser-compatible globals used in production.
import { describe, expect, it } from "vitest";
import { decodeResumeHandoff, encodeResumeHandoff } from "./resume-handoff.js";

const gatewayUrl = "wss://gateway.example/openclaw";
const maxEncodedLength = 4096;

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeText(encoded: string): string {
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

describe("resume handoff contract", () => {
  it("round-trips hostile cross-shell fields through only the inert base64url alphabet", () => {
    const sessionKey = "agent:runner:hostile-'\"$&;|<>^()%![]{}\\`-%PATH%-��";
    const hostileGatewayUrl = "wss://gateway.example/openclaw/$&;=()+,![]{}'`/%25PATH%25/%E2%98%83";

    const encoded = encodeResumeHandoff({ sessionKey, gatewayUrl: hostileGatewayUrl });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded).not.toContain("=");
    expect(decodeText(encoded)).toBe(
      JSON.stringify({ version: 1, sessionKey, gatewayUrl: hostileGatewayUrl }),
    );
    expect(decodeResumeHandoff(encoded)).toEqual({
      version: 1,
      sessionKey,
      gatewayUrl: hostileGatewayUrl,
    });
  });

  it.each([
    ["malformed alphabet", "not+base64url"],
    ["padding", "Zg=="],
    ["noncanonical encoding", "Zh"],
    ["invalid UTF-8", encodeBytes(Uint8Array.from([0xc3, 0x28]))],
    ["invalid JSON", encodeBytes(new TextEncoder().encode("not json"))],
    ["array", encodeJson([1, "agent:main:alpha", gatewayUrl])],
    ["null", encodeJson(null)],
    ["missing field", encodeJson({ version: 1, sessionKey: "agent:main:alpha" })],
    [
      "extra field",
      encodeJson({ version: 1, sessionKey: "agent:main:alpha", gatewayUrl, token: "nope" }),
    ],
    ["wrong version", encodeJson({ version: 2, sessionKey: "agent:main:alpha", gatewayUrl })],
    [
      "wrong version type",
      encodeJson({ version: "1", sessionKey: "agent:main:alpha", gatewayUrl }),
    ],
    ["wrong key type", encodeJson({ version: 1, sessionKey: 42, gatewayUrl })],
    ["wrong URL type", encodeJson({ version: 1, sessionKey: "agent:main:alpha", gatewayUrl: 42 })],
    ["empty key", encodeJson({ version: 1, sessionKey: "", gatewayUrl })],
    ["key C0 control", encodeJson({ version: 1, sessionKey: "agent:main:bad\nkey", gatewayUrl })],
    [
      "key C1 control",
      encodeJson({ version: 1, sessionKey: "agent:main:bad\u0085key", gatewayUrl }),
    ],
    [
      "URL C0 control",
      encodeJson({ version: 1, sessionKey: "agent:main:alpha", gatewayUrl: `${gatewayUrl}\u0000` }),
    ],
    [
      "non-WebSocket URL",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "https://gateway.example",
      }),
    ],
    [
      "invalid URL",
      encodeJson({ version: 1, sessionKey: "agent:main:alpha", gatewayUrl: "wss://[invalid" }),
    ],
    [
      "URL userinfo",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://user@gateway.example/ws",
      }),
    ],
    [
      "empty URL userinfo",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://@gateway.example/ws",
      }),
    ],
    [
      "URL query",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://gateway.example/ws?x=1",
      }),
    ],
    [
      "URL fragment",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://gateway.example/ws#x",
      }),
    ],
    ["encoded payload over limit", "A".repeat(maxEncodedLength + 1)],
    ["session key over limit", encodeJson({ version: 1, sessionKey: "s".repeat(513), gatewayUrl })],
    [
      "Gateway URL over limit",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: `wss://gateway.example/${"u".repeat(2049 - "wss://gateway.example/".length)}`,
      }),
    ],
  ])("rejects %s", (_name, encoded) => {
    expect(() => decodeResumeHandoff(encoded)).toThrow(
      "Invalid --handoff payload. Copy a fresh command from the Control UI.",
    );
  });

  it.each([
    ["empty key", { sessionKey: "", gatewayUrl }],
    ["session key over limit", { sessionKey: "s".repeat(513), gatewayUrl }],
    ["key control", { sessionKey: "agent:main:bad\u0085key", gatewayUrl }],
    ["empty URL", { sessionKey: "agent:main:alpha", gatewayUrl: "" }],
    [
      "Gateway URL over limit",
      {
        sessionKey: "agent:main:alpha",
        gatewayUrl: `wss://gateway.example/${"u".repeat(2049 - "wss://gateway.example/".length)}`,
      },
    ],
    ["URL query", { sessionKey: "agent:main:alpha", gatewayUrl: `${gatewayUrl}?x=1` }],
  ])("refuses to encode %s", (_name, input) => {
    expect(() => encodeResumeHandoff(input)).toThrow(
      "Invalid --handoff payload. Copy a fresh command from the Control UI.",
    );
  });
});
