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
});
