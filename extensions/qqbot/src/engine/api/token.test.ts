import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "./token.js";

describe("QQBot token manager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps malformed access token JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(new TokenManager().getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );
  });
});
