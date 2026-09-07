// Guards the Prometheus scrape route's own operator.read authorization.
import { createServer } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseEvent, createMetricsHarness, trusted } from "./service.test-helpers.js";

// The Gateway publishes the caller's effective operator scopes through the plugin runtime
// request scope; these tests drive that seam because the route handler reads it directly.
const runtimeScope = vi.hoisted(() => {
  let scopes: string[] | undefined;
  return {
    setScopes(next: string[] | undefined) {
      scopes = next;
    },
    current() {
      return scopes ? { client: { connect: { scopes } } } : undefined;
    },
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => runtimeScope.current(),
}));

const markerModel = "scope-guard-marker-model";

async function withScrapeTarget(run: (url: string) => Promise<void>): Promise<void> {
  const metrics = createMetricsHarness();
  metrics.record(
    {
      ...baseEvent(),
      type: "model.usage",
      agentId: "main",
      provider: "marker-provider",
      model: markerModel,
      usage: { input: 7 },
    },
    trusted,
  );
  const server = createServer((req, res) => {
    void metrics.handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}/api/diagnostics/prometheus`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    metrics.stop();
  }
}

describe("metrics HTTP handler scope authorization", () => {
  beforeEach(() => {
    runtimeScope.setScopes(["operator.read"]);
  });

  it("rejects a scrape from an authenticated caller whose role has no operator.read", async () => {
    runtimeScope.setScopes([]);
    await withScrapeTarget(async (url) => {
      const response = await fetch(url);
      const body = await response.text();
      expect(response.status).toBe(403);
      expect(body).toBe("missing scope: operator.read");
      expect(body).not.toContain(markerModel);
    });
  });

  it("rejects a HEAD probe without operator.read so the document size stays private", async () => {
    runtimeScope.setScopes([]);
    await withScrapeTarget(async (url) => {
      const response = await fetch(url, { method: "HEAD" });
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("text/plain");
    });
  });

  it("rejects a scrape when no gateway request scope is present", async () => {
    runtimeScope.setScopes(undefined);
    await withScrapeTarget(async (url) => {
      const response = await fetch(url);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(markerModel);
    });
  });

  it("rejects a scrape whose scopes only cover unrelated operator surfaces", async () => {
    runtimeScope.setScopes(["operator.approvals", "operator.questions"]);
    await withScrapeTarget(async (url) => {
      const response = await fetch(url);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(markerModel);
    });
  });

  it.each(["operator.read", "operator.write", "operator.admin"])(
    "serves metrics to a caller holding %s",
    async (scope) => {
      runtimeScope.setScopes([scope]);
      await withScrapeTarget(async (url) => {
        const response = await fetch(url);
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body).toContain(markerModel);
      });
    },
  );
});
