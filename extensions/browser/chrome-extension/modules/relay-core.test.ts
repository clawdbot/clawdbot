// Pure-logic tests for the OpenClaw Chrome extension. Runs under the
// extension-browser vitest glob (extensions/browser/**/*.test.ts).
import { describe, expect, it } from "vitest";
import {
  buildRelayWsProtocols,
  nearestGroupColor,
  parsePairingString,
  reconnectDelayMs,
} from "./relay-core.js";

const RELAY_SECRET = "a".repeat(64);

describe("parsePairingString", () => {
  it("parses a valid pairing string the CLI emits", () => {
    const parsed = parsePairingString(`ws://127.0.0.1:18797/extension#${RELAY_SECRET}`);
    expect(parsed).toEqual({
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: RELAY_SECRET,
    });
  });

  it("round-trips with the CLI pairing format", () => {
    const port = 18797;
    const token = RELAY_SECRET;
    const pairing = `ws://127.0.0.1:${port}/extension#${token}`;
    const parsed = parsePairingString(pairing);
    if (!parsed) {
      throw new Error("expected pairing string to parse");
    }
    expect(parsed.relayUrl).toBe(`ws://127.0.0.1:${port}/extension`);
    expect(buildRelayWsProtocols(parsed.token)).toEqual([
      "openclaw-extension-relay",
      `openclaw-extension-token.${token}`,
    ]);
  });

  it("extracts the additive direct Gateway hint without passing it to the relay", () => {
    const gatewayUrl = "wss://gateway.example.com/base";
    const pairing = `ws://127.0.0.1:18797/extension?gateway=${encodeURIComponent(gatewayUrl)}#${RELAY_SECRET}`;
    expect(parsePairingString(pairing)).toEqual({
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: RELAY_SECRET,
      gatewayUrl,
    });
  });

  it.each([
    "ws://localhost.:18797/extension",
    "ws://127.25.0.1:18797/extension",
    "ws://[::1]:18797/extension",
    "ws://[::ffff:127.0.0.1]:18797/extension",
    "wss://gateway.example.com/browser/extension",
  ])("accepts the supported relay transport %s", (relayUrl) => {
    expect(parsePairingString(`${relayUrl}#${RELAY_SECRET}`)?.token).toBe(RELAY_SECRET);
  });

  it.each([
    ["an empty string", ""],
    ["an HTTP URL", `http://127.0.0.1/extension#${RELAY_SECRET}`],
    ["a non-loopback plaintext URL", `ws://gateway.example.com/extension#${RELAY_SECRET}`],
    ["relay credentials", `wss://user:pass@gateway.example.com/extension#${RELAY_SECRET}`],
    ["the wrong path", `ws://127.0.0.1/other#${RELAY_SECRET}`],
    ["a missing secret", "ws://127.0.0.1/extension#"],
    ["a short secret", "ws://127.0.0.1/extension#abc123"],
    ["an uppercase secret", `ws://127.0.0.1/extension#${"A".repeat(64)}`],
    ["an unknown query parameter", `ws://127.0.0.1/extension?token=nope#${RELAY_SECRET}`],
    [
      "duplicate Gateway hints",
      `ws://127.0.0.1/extension?gateway=wss%3A%2F%2Fone.example&gateway=wss%3A%2F%2Ftwo.example#${RELAY_SECRET}`,
    ],
    ["an empty Gateway hint", `ws://127.0.0.1/extension?gateway=#${RELAY_SECRET}`],
    [
      "a credentialed Gateway hint",
      `ws://127.0.0.1/extension?gateway=${encodeURIComponent("wss://user:pass@gateway.example.com")}#${RELAY_SECRET}`,
    ],
    [
      "an insecure remote Gateway hint",
      `ws://127.0.0.1/extension?gateway=${encodeURIComponent("ws://gateway.example.com")}#${RELAY_SECRET}`,
    ],
  ])("rejects %s", (_label, pairing) => {
    expect(parsePairingString(pairing)).toBeNull();
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially and caps at 30s", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(4)).toBe(16_000);
    expect(reconnectDelayMs(5)).toBe(30_000);
    expect(reconnectDelayMs(50)).toBe(30_000);
  });
});

describe("nearestGroupColor", () => {
  it("maps hex accents to Chrome tab-group color names", () => {
    expect(nearestGroupColor("#FF4500")).toBe("orange");
    expect(nearestGroupColor("#00AA00")).toBe("green");
    expect(nearestGroupColor("#4285F4")).toBe("blue");
  });

  it("falls back to orange for invalid input", () => {
    expect(nearestGroupColor("not-a-color")).toBe("orange");
    expect(nearestGroupColor(undefined)).toBe("orange");
  });
});
