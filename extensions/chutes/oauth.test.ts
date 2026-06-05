// Chutes tests cover oauth plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { loginChutes } from "./oauth.js";

describe("chutes plugin OAuth", () => {
  it("rejects unsafe token lifetimes before storing credentials", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          '{"access_token":"at_unsafe","refresh_token":"rt_unsafe","expires_in":1e309}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      }),
    ).rejects.toThrow("Chutes token exchange returned invalid expires_in");
  });
});
