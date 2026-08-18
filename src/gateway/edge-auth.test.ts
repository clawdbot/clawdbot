import { afterEach, describe, expect, it } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  gatewayEdgeAuthValueForTarget,
  normalizeEdgeAuthHeadersConfig,
  resolveEdgeAuthHeaders,
} from "./edge-auth.js";

describe("gateway edge auth headers", () => {
  afterEach(() => {
    resetSecretRedactionRegistryForTest();
  });

  it("normalizes valid literal and SecretRef header values", () => {
    expect(
      normalizeEdgeAuthHeadersConfig({
        "X-Edge-Literal": " literal-value ",
        "X-Edge-Ref": { source: "env", provider: "default", id: "EDGE_AUTH_TOKEN" },
      }),
    ).toEqual({
      "X-Edge-Literal": "literal-value",
      "X-Edge-Ref": { source: "env", provider: "default", id: "EDGE_AUTH_TOKEN" },
    });
  });

  it.each([
    "host",
    "connection",
    "upgrade",
    "content-length",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ])("rejects transport-owned header %s case-insensitively", (headerName) => {
    const mixedCaseName = headerName
      .split("-")
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join("-");
    expect(() => normalizeEdgeAuthHeadersConfig({ [mixedCaseName]: "test-secret" })).toThrow(
      /transport-owned header/u,
    );
  });

  it("rejects non-records, invalid names, empty maps, and case-duplicate names", () => {
    expect(() => normalizeEdgeAuthHeadersConfig(["X-Edge-Auth", "test-secret"])).toThrow(
      /expected a header map/u,
    );
    expect(() => normalizeEdgeAuthHeadersConfig({ "Bad Header": "test-secret" })).toThrow(
      /invalid gateway\.remote\.edgeAuth header name/u,
    );
    expect(() => normalizeEdgeAuthHeadersConfig({})).toThrow(/must not be empty/u);
    expect(() =>
      normalizeEdgeAuthHeadersConfig({ "X-Edge-Auth": "one", "x-edge-auth": "two" }),
    ).toThrow(/differ only by case/u);
  });

  it("materializes SecretRefs and registers every resolved value for redaction", async () => {
    const first = "test-token";
    const second = "test-secret";
    const value = normalizeEdgeAuthHeadersConfig({
      "X-Edge-Token": { source: "env", provider: "default", id: "EDGE_AUTH_TOKEN" },
      "X-Edge-Secret": { source: "env", provider: "default", id: "EDGE_AUTH_SECRET" },
    });

    await expect(
      resolveEdgeAuthHeaders({
        config: {},
        value,
        env: { EDGE_AUTH_TOKEN: first, EDGE_AUTH_SECRET: second },
      }),
    ).resolves.toEqual({ "X-Edge-Token": first, "X-Edge-Secret": second });
    expect(isSecretValueRegisteredForRedaction(first)).toBe(true);
    expect(isSecretValueRegisteredForRedaction(second)).toBe(true);
  });

  it("names the header when a resolved value is empty", async () => {
    await expect(
      resolveEdgeAuthHeaders({
        config: {},
        value: { "X-Empty-Edge-Auth": " " },
        env: {},
      }),
    ).rejects.toThrow('gateway.remote.edgeAuth header "X-Empty-Edge-Auth" resolved empty');
  });

  it("binds configured headers to the exact configured remote Gateway scope", async () => {
    const config = {
      gateway: {
        mode: "remote" as const,
        remote: {
          url: "wss://gateway.example/rpc",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    };

    const matchingConfig = normalizeEdgeAuthHeadersConfig(
      gatewayEdgeAuthValueForTarget({
        config,
        targetUrl: "wss://gateway.example/rpc",
      }),
    );
    expect(matchingConfig).toEqual({ "X-Edge-Auth": "test-secret" });
    await expect(
      resolveEdgeAuthHeaders({ config, value: matchingConfig, env: {} }),
    ).resolves.toEqual({ "X-Edge-Auth": "test-secret" });
    expect(
      gatewayEdgeAuthValueForTarget({ config, targetUrl: "wss://other.example/rpc" }),
    ).toBeUndefined();
  });
});
