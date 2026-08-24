import { describe, expect, it } from "vitest";
import { createBrowserProxyFailure, parseBrowserProxyFailure } from "./browser-proxy-envelope.js";

describe("browser proxy error envelope", () => {
  it("preserves validated action error codes and drops unknown metadata", () => {
    const failure = createBrowserProxyFailure(403, {
      error: "evaluation disabled",
      code: "ACT_EVALUATE_DISABLED",
      untrusted: "drop me",
    });

    expect(parseBrowserProxyFailure(failure)).toEqual({
      error: {
        status: 403,
        body: { error: "evaluation disabled", code: "ACT_EVALUATE_DISABLED" },
      },
    });
  });
});
