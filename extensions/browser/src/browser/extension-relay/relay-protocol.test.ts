// Extension relay protocol frame parsing.
import { describe, expect, it } from "vitest";
import { parseExtensionMessage } from "./relay-protocol.js";

describe("parseExtensionMessage", () => {
  const validHello = {
    type: "hello",
    userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
    browserVersion: "Chrome/144.0.0.0",
    extensionVersion: "2.0.0",
    tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
  };

  it("accepts known frame types", () => {
    expect(parseExtensionMessage(JSON.stringify(validHello))).toEqual(validHello);
    expect(parseExtensionMessage(JSON.stringify({ type: "pong" }))).toEqual({ type: "pong" });
    expect(
      parseExtensionMessage(JSON.stringify({ type: "result", seq: 3, result: { ok: true } })),
    ).toMatchObject({ type: "result", seq: 3 });
    expect(
      parseExtensionMessage(
        JSON.stringify({
          type: "tabs",
          tabs: [{ tabId: 2, url: "https://example.com/2", title: "Two", active: false }],
        }),
      ),
    ).toMatchObject({ type: "tabs", tabs: [{ tabId: 2 }] });
    expect(
      parseExtensionMessage(JSON.stringify({ type: "cdpEvent", tabId: 1, method: "Page.load" })),
    ).toMatchObject({ type: "cdpEvent", tabId: 1 });
    expect(
      parseExtensionMessage(JSON.stringify({ type: "detached", tabId: 1, reason: "cancel" })),
    ).toMatchObject({ type: "detached", tabId: 1 });
  });

  it.each([
    ["missing identity", { ...validHello, userAgent: undefined }],
    ["empty browser version", { ...validHello, browserVersion: "" }],
    ["oversized user agent", { ...validHello, userAgent: "x".repeat(2_049) }],
    ["an extra hello field", { ...validHello, extra: true }],
    ["non-array tabs", { ...validHello, tabs: {} }],
    [
      "a fractional tab id",
      { ...validHello, tabs: [{ tabId: 1.5, url: "", title: "", active: true }] },
    ],
    [
      "an extra tab field",
      {
        ...validHello,
        tabs: [{ tabId: 1, url: "", title: "", active: true, incognito: false }],
      },
    ],
    [
      "duplicate tab ids",
      {
        ...validHello,
        tabs: [
          { tabId: 1, url: "https://one.example", title: "One", active: true },
          { tabId: 1, url: "https://two.example", title: "Two", active: false },
        ],
      },
    ],
  ])("rejects a hello with %s", (_label, hello) => {
    expect(parseExtensionMessage(JSON.stringify(hello))).toBeNull();
  });

  it("rejects malformed or unknown frames", () => {
    expect(parseExtensionMessage("not json")).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ type: "evil" }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ noType: true }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify(42))).toBeNull();
  });

  // The bridge dereferences frame fields without try/catch (bindSocket invokes
  // the handler straight from the ws "message" event), so parse must reject
  // frames whose payload shape would crash syncTabs/handleExtensionMessage.
  it("rejects frames with malformed payload fields", () => {
    const cases: unknown[] = [
      // hello: identity fields and tab list must be present and typed.
      { ...validHello, tabs: {} },
      { ...validHello, tabs: null },
      { ...validHello, tabs: [null] },
      { ...validHello, tabs: [{ tabId: "1", url: "u", title: "t", active: true }] },
      { ...validHello, userAgent: 42 },
      // tabs: same tab-list shape as hello.
      { type: "tabs", tabs: {} },
      { type: "tabs", tabs: null },
      { type: "tabs", tabs: [null] },
      { type: "tabs", tabs: [{ tabId: 1, url: "u", title: "t" }] },
      { type: "tabs", tabs: [{ tabId: 1.5, url: "u", title: "t", active: true }] },
      {
        type: "tabs",
        tabs: [
          { tabId: 1, url: "u", title: "t", active: true },
          { tabId: 1, url: "v", title: "s", active: false },
        ],
      },
      // cdpEvent: numeric tabId + string method.
      { type: "cdpEvent", tabId: "1", method: "Page.load" },
      { type: "cdpEvent", tabId: 1.5, method: "Page.load" },
      { type: "cdpEvent", tabId: 1 },
      { type: "cdpEvent", tabId: 1, sessionId: 2, method: "Page.load" },
      // result/error: numeric seq correlates the pending command.
      { type: "result", seq: "3" },
      { type: "result", seq: -1 },
      { type: "result", seq: 1.5 },
      { type: "error", seq: null, message: "boom" },
      { type: "error", seq: 3, message: {} },
      // detached: numeric tabId.
      { type: "detached", tabId: "1", reason: "cancel" },
      { type: "detached", tabId: 1, reason: null },
    ];
    for (const frame of cases) {
      expect(parseExtensionMessage(JSON.stringify(frame))).toBeNull();
    }
  });
});
