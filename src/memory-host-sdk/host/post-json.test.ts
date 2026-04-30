import { describe, expect, it, vi } from "vitest";
import { postJson } from "./post-json.js";

describe("postJson", () => {
  it("parses JSON from an injected fetch response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const result = await postJson({
      url: "https://example.com/v1/post",
      headers: { Authorization: "Bearer test" },
      ssrfPolicy: { allowedHostnames: ["example.com"] },
      fetchImpl,
      body: { input: ["x"] },
      errorPrefix: "post failed",
      parse: (payload) => payload,
    });

    expect(result).toEqual({ ok: true });
  });
});
