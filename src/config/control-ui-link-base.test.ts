import { describe, expect, it } from "vitest";
import { resolveControlUiSessionLinkBase } from "./control-ui-link-base.js";

describe("resolveControlUiSessionLinkBase", () => {
  it("omits session links without a public Gateway origin", () => {
    expect(resolveControlUiSessionLinkBase({ gateway: {} })).toBeUndefined();
  });

  it("omits session links when the Control UI is disabled", () => {
    expect(
      resolveControlUiSessionLinkBase({
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { enabled: false },
        },
      }),
    ).toBeUndefined();
  });

  it("joins a valid public origin with the normalized Control UI base path", () => {
    expect(
      resolveControlUiSessionLinkBase({
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { basePath: " /control/// " },
        },
      }),
    ).toBe("http://127.0.0.1:18789/control");
  });

  it("preserves a session link base just under the hard cap", () => {
    const origin = "http://127.0.0.1:18789";
    const basePath = `/${"a".repeat(176)}`;
    const expected = `${origin}${basePath}`;
    expect(expected).toHaveLength(199);
    expect(
      resolveControlUiSessionLinkBase({
        gateway: { publicOrigin: origin, controlUi: { basePath } },
      }),
    ).toBe(expected);
  });

  it("omits a session link base with an oversized Control UI base path", () => {
    expect(
      resolveControlUiSessionLinkBase({
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { basePath: `/${"a".repeat(178)}` },
        },
      }),
    ).toBeUndefined();
  });

  it("omits a session link base with an oversized public origin", () => {
    const publicOrigin = `https://${"a.".repeat(91)}example.com`;
    expect(publicOrigin).toHaveLength(201);
    expect(resolveControlUiSessionLinkBase({ gateway: { publicOrigin } })).toBeUndefined();
  });
});
