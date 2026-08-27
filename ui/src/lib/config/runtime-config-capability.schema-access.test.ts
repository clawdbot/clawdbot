// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createGatewayHarness } from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config schema access", () => {
  it("loads the schema for a legacy hello without scopes or an advertised method list", async () => {
    const schema = {
      schema: { type: "object" },
      uiHints: {},
      version: "schema-legacy",
      generatedAt: "2026-08-15T00:00:00.000Z",
    };
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? { config: {}, hash: "hash-legacy", valid: true, issues: [] }
        : method === "config.schema"
          ? schema
          : {},
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator" },
    } as GatewayHelloOk);
    await runtimeConfig.ensureSchemaLoaded();

    expect(request).toHaveBeenCalledWith("config.schema", {});
    expect(runtimeConfig.state.configSchemaVersion).toBe("schema-legacy");
    runtimeConfig.dispose();
  });

  it("skips the schema load when advertised scopes exclude operator.read", async () => {
    const request = vi.fn(async () => ({}));
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.pairing"] },
      features: { methods: ["config.schema"] },
    } as GatewayHelloOk);
    await runtimeConfig.ensureSchemaLoaded();

    expect(request).not.toHaveBeenCalledWith("config.schema", {});
    runtimeConfig.dispose();
  });
});
