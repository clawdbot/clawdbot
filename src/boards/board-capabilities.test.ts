import { describe, expect, it } from "vitest";
import {
  BOARD_CRON_JOB_ID_MAX_LENGTH,
  BOARD_CRON_TRIGGER_PREFIX,
  BOARD_WIDGET_TOOL_MAX_LENGTH,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeBoardWidgetDeclared } from "./board-capabilities.js";

const usernameOrigin = new URL("https://api.example.com");
usernameOrigin.username = "fixture-user";
const passwordOrigin = new URL("https://api.example.com");
passwordOrigin.username = "fixture-user";
passwordOrigin.password = "fixture-password";

describe("board widget capabilities", () => {
  it.each([
    ["https://api.open-meteo.com", "https://api.open-meteo.com"],
    ["https://api.example.com:8443", "https://api.example.com:8443"],
    ["https://xn--bcher-kva.example", "https://xn--bcher-kva.example"],
    ["https://[2001:db8::1]:9443", "https://[2001:db8::1]:9443"],
  ])("accepts exact HTTPS origin %s", (input, expected) => {
    expect(normalizeBoardWidgetDeclared({ netOrigins: [input] })).toEqual({
      netOrigins: [expected],
    });
  });

  it.each([
    "http://api.example.com",
    "wss://api.example.com",
    "https://*.example.com",
    usernameOrigin.href,
    passwordOrigin.href,
    "https://api.example.com/path",
    "https://api.example.com?query=1",
    "https://api.example.com/#fragment",
    "https://api_internal.example",
    " https://api.example.com",
    "https://api.example.com.",
  ])("rejects non-origin network declaration %s", (input) => {
    expect(() => normalizeBoardWidgetDeclared({ netOrigins: [input] })).toThrow(
      /exact HTTPS origin|invalid/u,
    );
  });

  it("canonicalizes, deduplicates, and sorts declarations", () => {
    expect(
      normalizeBoardWidgetDeclared({
        netOrigins: ["https://z.example", "https://a.example", "https://z.example"],
        tools: ["sessions.list", "prompt", "prompt"],
      }),
    ).toEqual({
      netOrigins: ["https://a.example", "https://z.example"],
      tools: ["prompt", "sessions.list"],
    });
  });

  it("rejects an origin set that cannot fit the sandbox CSP transport", () => {
    const longHost = ["a".repeat(50), "b".repeat(50), "c".repeat(50)].join(".");
    const netOrigins = Array.from(
      { length: 32 },
      (_, index) => `https://${index}.${longHost}.example`,
    );

    expect(() => normalizeBoardWidgetDeclared({ netOrigins })).toThrow(/safe CSP limits/u);
  });

  it("fits the full cron job id contract in an exact trigger capability", () => {
    const capability = `${BOARD_CRON_TRIGGER_PREFIX}${"j".repeat(BOARD_CRON_JOB_ID_MAX_LENGTH)}`;

    expect(capability).toHaveLength(BOARD_WIDGET_TOOL_MAX_LENGTH);
    expect(normalizeBoardWidgetDeclared({ tools: [capability] })).toEqual({
      tools: [capability],
    });
    expect(() => normalizeBoardWidgetDeclared({ tools: [`${capability}x`] })).toThrow(
      /invalid board widget tool capability/u,
    );
  });
});
