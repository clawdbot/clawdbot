import { describe, expect, it } from "vitest";
import {
  buildLlamaServerAuthHeaders,
  hasLlamaServerAuthorizationHeader,
  resolveLlamaServerProviderHeaders,
  shouldUseLlamaServerSyntheticAuth,
} from "./auth.js";

describe("llama-server auth", () => {
  it.each([undefined, null, [], "Bearer proxy-token"])(
    "rejects a non-record authorization header container: %j",
    (headers) => {
      expect(hasLlamaServerAuthorizationHeader(headers)).toBe(false);
    },
  );

  it("uses synthetic runtime auth for no-auth and header-only providers", () => {
    expect(
      shouldUseLlamaServerSyntheticAuth({ baseUrl: "http://localhost:8080/v1", models: [] }),
    ).toBe(true);
    expect(
      shouldUseLlamaServerSyntheticAuth({
        baseUrl: "http://localhost:8080/v1",
        headers: { authorization: "Bearer proxy-token" },
        models: [],
      }),
    ).toBe(true);
    expect(
      shouldUseLlamaServerSyntheticAuth({
        baseUrl: "http://localhost:8080/v1",
        apiKey: "server-key",
        models: [],
      }),
    ).toBe(false);
    expect(hasLlamaServerAuthorizationHeader({ authorization: "Bearer proxy-token" })).toBe(true);
  });

  it("preserves configured headers unless a real API key replaces authorization", () => {
    expect(
      buildLlamaServerAuthHeaders(undefined, {
        Authorization: "Bearer proxy-token",
        "X-Tenant": "one",
      }),
    ).toEqual({
      Accept: "application/json",
      Authorization: "Bearer proxy-token",
      "X-Tenant": "one",
    });
    expect(
      buildLlamaServerAuthHeaders("server-key", {
        authorization: "Bearer proxy-token",
        "X-Tenant": "one",
      }),
    ).toEqual({
      Accept: "application/json",
      Authorization: "Bearer server-key",
      "X-Tenant": "one",
    });
  });

  it("resolves provider header templates for discovery", async () => {
    const config = {
      models: {
        providers: {
          "llama-server": {
            baseUrl: "http://localhost:8080/v1",
            headers: { "X-Proxy-Key": "${LLAMA_PROXY_TOKEN}" },
            models: [],
          },
        },
      },
    };
    await expect(
      resolveLlamaServerProviderHeaders({
        config,
        env: { LLAMA_PROXY_TOKEN: "proxy-token" },
        headers: config.models.providers["llama-server"].headers,
      }),
    ).resolves.toEqual({ "X-Proxy-Key": "proxy-token" });
  });

  it("filters and trims plain provider headers without config", async () => {
    await expect(
      resolveLlamaServerProviderHeaders({
        headers: {
          "X-Proxy-Key": " proxy-token ",
          "X-Empty": " ",
          "X-Invalid": 42,
        },
      }),
    ).resolves.toEqual({ "X-Proxy-Key": "proxy-token" });
    await expect(resolveLlamaServerProviderHeaders({ headers: [] })).resolves.toBeUndefined();
  });
});
