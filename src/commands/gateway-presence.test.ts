import { describe, expect, it } from "vitest";
import { pickGatewaySelfPresence } from "./gateway-presence.js";

describe("pickGatewaySelfPresence", () => {
  it("extracts host and ip from legacy gateway self text", () => {
    expect(
      pickGatewaySelfPresence([
        {
          text: "Gateway: gateway-host (192.0.2.10) · app 2026.5.22 · mode gateway · reason self",
        },
      ]),
    ).toStrictEqual({
      host: "gateway-host",
      ip: "192.0.2.10",
      version: undefined,
      platform: undefined,
    });
  });

  it("prefers structured gateway self fields over legacy text", () => {
    expect(
      pickGatewaySelfPresence([
        {
          text: "Gateway: legacy-host (192.0.2.10) · app 2026.5.22 · mode gateway · reason self",
          host: "structured-host",
          ip: "192.0.2.11",
          version: "2026.5.23",
          platform: "linux",
          mode: "gateway",
          reason: "self",
        },
      ]),
    ).toStrictEqual({
      host: "structured-host",
      ip: "192.0.2.11",
      version: "2026.5.23",
      platform: "linux",
    });
  });
});
