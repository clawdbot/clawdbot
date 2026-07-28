// Pure-logic tests for the OpenClaw Chrome extension. Runs under the
// extension-browser vitest glob (extensions/browser/**/*.test.ts).
import { describe, expect, it } from "vitest";
import {
  buildRelayWsProtocols,
  nearestGroupColor,
  parsePairingString,
  reconnectDelayMs,
} from "./relay-core.js";

describe("parsePairingString", () => {
  it("parses a valid pairing string the CLI emits", () => {
    const parsed = parsePairingString("ws://127.0.0.1:18797/extension#deadbeefcafe");
    expect(parsed).toEqual({
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: "deadbeefcafe",
    });
  });

  it("round-trips with the CLI pairing format", () => {
    const port = 18797;
    const token = "abc123";
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

  it("rejects malformed strings", () => {
    expect(parsePairingString("")).toBeNull();
    expect(parsePairingString("http://127.0.0.1/extension#tok")).toBeNull();
    expect(parsePairingString("ws://127.0.0.1/other#tok")).toBeNull();
    expect(parsePairingString("ws://127.0.0.1/extension#")).toBeNull();
    expect(parsePairingString("ws://127.0.0.1/extension")).toBeNull();
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
