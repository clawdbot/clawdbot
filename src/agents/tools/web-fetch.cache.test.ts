import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createWebFetchTool } from "./web-fetch.js";

const runtimeState = vi.hoisted(() => ({
  config: undefined as OpenClawConfig | undefined,
  resolveWebFetchDefinition: vi.fn(),
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: () => ({ config: runtimeState.config }),
}));
vi.mock("../../secrets/runtime-web-tools-state.js", () => ({
  getActiveRuntimeWebToolsMetadataFromState: () => null,
}));
vi.mock("../../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: runtimeState.resolveWebFetchDefinition,
}));

afterEach(() => {
  runtimeState.config = undefined;
  runtimeState.resolveWebFetchDefinition.mockReset();
});

describe.each(["direct", "provider fallback"])("web_fetch %s cache", (source) => {
  it.each([0, 15])("honors zero TTL after starting with TTL %i", async (initialTtl) => {
    let body = "original body";
    let networkCalls = 0;
    const providerExecute = vi.fn(async () => ({ text: body }));
    runtimeState.resolveWebFetchDefinition.mockReturnValue({
      provider: { id: "test-fetch-provider" },
      definition: { execute: providerExecute },
    });
    const server = createServer((_request, response) => {
      networkCalls += 1;
      response.writeHead(source === "direct" ? 200 : 503, { "content-type": "text/plain" });
      response.end(body);
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a loopback TCP address");
      }
      const args = { url: `http://127.0.0.1:${address.port}/cache-ttl-${initialTtl}-${source}` };
      const setTtl = (cacheTtlMinutes: number) => {
        runtimeState.config = {
          tools: {
            web: { fetch: { cacheTtlMinutes, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } } },
          },
        };
      };
      setTtl(initialTtl);
      const tool = createWebFetchTool({ lateBindRuntimeConfig: true });
      if (!tool) {
        throw new Error("expected web_fetch to be enabled");
      }
      const first = await tool.execute("populate", args);
      expect(first.details).toMatchObject({ text: expect.stringContaining("original body") });
      if (initialTtl > 0) {
        expect((await tool.execute("cached", args)).details).toMatchObject({ cached: true });
      }
      expect(networkCalls).toBe(1);

      setTtl(0);
      for (const freshBody of ["fresh body", "newest body"]) {
        body = freshBody;
        const result = await tool.execute("uncached", args);
        expect(result.details).toMatchObject({ text: expect.stringContaining(freshBody) });
        expect(result.details).not.toHaveProperty("cached");
      }
      expect(networkCalls).toBe(3);
      expect(providerExecute).toHaveBeenCalledTimes(source === "direct" ? 0 : 3);

      // Disabled requests neither replace another caller's entry nor insert their own.
      setTtl(15);
      body = "after re-enable";
      const enabled = await tool.execute("re-enabled", args);
      expect(enabled.details).toMatchObject({
        text: expect.stringContaining(initialTtl > 0 ? "original body" : "after re-enable"),
      });
      expect(networkCalls).toBe(initialTtl > 0 ? 3 : 4);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
});
