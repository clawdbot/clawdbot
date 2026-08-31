import { afterEach, describe, expect, it } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  nodeHostCloudflareAccessConfigFromEnv,
  nodeHostGatewayMatchesUrl,
  resolveNodeHostCloudflareAccess,
} from "./gateway-cloudflare-access.js";

describe("node-host Cloudflare Access credentials", () => {
  afterEach(() => {
    resetSecretRedactionRegistryForTest();
  });

  it("persists conventional environment fallback as SecretRefs and resolves it", async () => {
    const clientId = ["cf", "node", "id"].join("-");
    const clientSecret = ["cf", "node", "secret"].join("-");
    const env = {
      CF_ACCESS_CLIENT_ID: clientId,
      CF_ACCESS_CLIENT_SECRET: clientSecret,
    };
    const value = nodeHostCloudflareAccessConfigFromEnv(env);

    expect(value).toEqual({
      clientId: { source: "env", provider: "default", id: "CF_ACCESS_CLIENT_ID" },
      clientSecret: { source: "env", provider: "default", id: "CF_ACCESS_CLIENT_SECRET" },
    });
    await expect(resolveNodeHostCloudflareAccess({ value, config: {}, env })).resolves.toEqual({
      clientId,
      clientSecret,
    });
    expect(isSecretValueRegisteredForRedaction(clientId)).toBe(true);
    expect(isSecretValueRegisteredForRedaction(clientSecret)).toBe(true);
  });

  it("fails closed when only half of the credential pair is configured", () => {
    expect(() =>
      nodeHostCloudflareAccessConfigFromEnv({ CF_ACCESS_CLIENT_ID: "client-id-only" }),
    ).toThrow("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be configured together");
  });

  it("matches only the configured Gateway origin", () => {
    const gateway = { host: "gateway.example", port: 443, tls: true };
    expect(nodeHostGatewayMatchesUrl(gateway, new URL("https://gateway.example/j/code"))).toBe(
      true,
    );
    expect(nodeHostGatewayMatchesUrl(gateway, new URL("https://other.example/j/code"))).toBe(false);
    expect(nodeHostGatewayMatchesUrl(gateway, new URL("https://gateway.example:8443/j/code"))).toBe(
      false,
    );
  });
});
