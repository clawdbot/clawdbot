// Pure-logic tests for the OpenClaw Chrome extension. Runs under the
// extension-browser vitest glob (extensions/browser/**/*.test.ts).
import { describe, expect, it, vi } from "vitest";
import {
  buildRelayWsProtocols,
  createPairingConfigStore,
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
    expect(buildRelayWsProtocols()).toEqual(["openclaw-extension-relay.v2"]);
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

  it("retains and canonicalizes the profile auth binding while stripping the Gateway hint", () => {
    const pairing = `ws://127.0.0.1:18797/extension?profile=work&gateway=${encodeURIComponent("wss://gateway.example.com")}#${RELAY_SECRET}`;
    expect(parsePairingString(pairing)).toEqual({
      relayUrl: "ws://127.0.0.1:18797/extension?profile=work",
      token: RELAY_SECRET,
      gatewayUrl: "wss://gateway.example.com",
    });
  });

  it.each([
    "ws://localhost.:18797/extension",
    "ws://127.25.0.1:18797/extension",
    "ws://[::1]:18797/extension",
    "ws://[::ffff:127.0.0.1]:18797/extension",
    "ws://127.0.0.1:18789/browser/extension",
    "wss://gateway.example.com/browser/extension",
    "wss://gateway.example.com/browser/extension?profile=work",
  ])("accepts the supported relay transport %s", (relayUrl) => {
    expect(parsePairingString(`${relayUrl}#${RELAY_SECRET}`)?.token).toBe(RELAY_SECRET);
  });

  it.each([
    ["an empty string", ""],
    ["an HTTP URL", `http://127.0.0.1/extension#${RELAY_SECRET}`],
    ["a non-loopback plaintext URL", `ws://gateway.example.com/extension#${RELAY_SECRET}`],
    ["a remote relay path", `wss://gateway.example.com/extension#${RELAY_SECRET}`],
    [
      "a proxy-prefixed remote relay path",
      `wss://gateway.example.com/proxy/browser/extension#${RELAY_SECRET}`,
    ],
    [
      "a proxy-prefixed loopback direct-Gateway path",
      `ws://127.0.0.1:18789/proxy/browser/extension#${RELAY_SECRET}`,
    ],
    [
      "a suffixed remote relay path",
      `wss://gateway.example.com/browser/extension/extra#${RELAY_SECRET}`,
    ],
    ["relay credentials", `wss://user:pass@gateway.example.com/extension#${RELAY_SECRET}`],
    ["the wrong path", `ws://127.0.0.1/other#${RELAY_SECRET}`],
    ["a missing secret", "ws://127.0.0.1/extension#"],
    ["a short secret", "ws://127.0.0.1/extension#abc123"],
    ["an uppercase secret", `ws://127.0.0.1/extension#${"A".repeat(64)}`],
    ["an unknown query parameter", `ws://127.0.0.1/extension?token=nope#${RELAY_SECRET}`],
    ["duplicate profiles", `ws://127.0.0.1/extension?profile=one&profile=two#${RELAY_SECRET}`],
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

async function readStoredPairing(stored: Record<string, unknown>) {
  const config = await createPairingConfigStore({
    get: async () => stored,
    set: async () => undefined,
    remove: async () => undefined,
  }).read();
  if (!config.relayUrl) {
    return null;
  }
  return {
    relayUrl: config.relayUrl,
    token: config.token,
    ...(config.gatewayUrl ? { gatewayUrl: config.gatewayUrl } : {}),
  };
}

describe("persisted pairing storage", () => {
  it.each([
    {
      label: "a loopback relay without a Gateway hint",
      stored: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
      },
    },
    {
      label: "a loopback relay with an independent Gateway hint",
      stored: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com/base",
      },
    },
    {
      label: "an exact direct relay with its matching trailing-slash Gateway hint",
      stored: {
        relayUrl: "wss://gateway.example.com/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com/",
      },
    },
  ])("accepts $label", async ({ stored }) => {
    expect(await readStoredPairing(stored)).toEqual(stored);
  });

  it("migrates a canonical existing pairing to authVersion 2 without re-pairing", async () => {
    const stored = {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: RELAY_SECRET,
      gatewayUrl: "",
      groupColor: "orange",
    };
    const set = vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(stored, values);
    });
    const config = await createPairingConfigStore({
      get: async () => stored,
      set,
      remove: async () => undefined,
    }).read();
    expect(set).toHaveBeenCalledWith({ authVersion: 2 });
    expect(config).toMatchObject({
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: RELAY_SECRET,
      authVersion: 2,
    });
  });

  it("rejects and clears an unsupported stored auth version", async () => {
    const remove = vi.fn(async () => undefined);
    const config = await createPairingConfigStore({
      get: async () => ({
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "",
        authVersion: 1,
      }),
      set: async () => undefined,
      remove,
    }).read();
    expect(config.relayUrl).toBe("");
    expect(remove).toHaveBeenCalledWith(["relayUrl", "gatewayUrl", "token", "authVersion"]);
  });

  it.each([
    {
      relayUrl: "wss://gateway.example.com/proxy/browser/extension",
      gatewayUrl: "wss://gateway.example.com/proxy",
    },
    {
      relayUrl: "ws://127.0.0.1:18789/proxy/browser/extension",
      gatewayUrl: "ws://127.0.0.1:18789/proxy",
    },
  ])("clears stored proxy-prefixed direct pairing $relayUrl with safe guidance", async (route) => {
    const stored: Record<string, unknown> = {
      relayUrl: route.relayUrl,
      token: RELAY_SECRET,
      gatewayUrl: route.gatewayUrl,
      authVersion: 2,
    };
    const set = vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(stored, values);
    });
    const remove = vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        delete stored[key];
      }
    });
    const store = createPairingConfigStore({ get: async () => stored, set, remove });

    const config = await store.read();

    expect(config).toMatchObject({ relayUrl: "", token: "", authVersion: undefined });
    expect(config.pairingStatusHint).toContain("no path prefix");
    expect(config.pairingStatusHint).not.toContain(RELAY_SECRET);
    expect(remove).toHaveBeenCalledWith(["relayUrl", "gatewayUrl", "token", "authVersion"]);
    expect(set).toHaveBeenCalledWith({ pairingStatus: "proxy-prefix-unsupported" });

    const afterWorkerRestart = await createPairingConfigStore({
      get: async () => stored,
      set,
      remove,
    }).read();
    expect(afterWorkerRestart.pairingStatusHint).toContain("openclaw browser extension pair");
  });

  it.each([
    ["an invalid token", { relayUrl: "ws://127.0.0.1:18797/extension", token: "short" }],
    [
      "an unsafe remote relay",
      { relayUrl: "ws://gateway.example.com/extension", token: RELAY_SECRET },
    ],
    [
      "relay URL credentials",
      { relayUrl: "wss://user:pass@gateway.example.com/extension", token: RELAY_SECRET },
    ],
    [
      "an unsafe remote Gateway hint",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "ws://gateway.example.com",
      },
    ],
    [
      "Gateway URL credentials",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://user:pass@gateway.example.com",
      },
    ],
    [
      "a Gateway URL query",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com?token=nope",
      },
    ],
    [
      "a Gateway URL fragment",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com#fragment",
      },
    ],
    ["a malformed relay URL", { relayUrl: "not a URL", token: RELAY_SECRET }],
    [
      "an unknown relay query",
      { relayUrl: "ws://127.0.0.1:18797/extension?token=nope", token: RELAY_SECRET },
    ],
    [
      "duplicate relay queries",
      {
        relayUrl: "ws://127.0.0.1:18797/extension?gateway=one&gateway=two",
        token: RELAY_SECRET,
      },
    ],
    ["partial state", { relayUrl: "ws://127.0.0.1:18797/extension" }],
    [
      "a mismatched direct Gateway hint",
      {
        relayUrl: "wss://gateway.example.com/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://other.example.com",
      },
    ],
  ])("rejects %s", async (_label, stored) => {
    expect(await readStoredPairing(stored)).toBeNull();
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
