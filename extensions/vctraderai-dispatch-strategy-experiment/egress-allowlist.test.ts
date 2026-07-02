import { describe, expect, it, vi } from "vitest";
import { runDispatchStrategyExperiment } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

describe("vctraderai-dispatch-strategy-experiment egress allowlist", () => {
  it("the stage path is permitted by the allowlist", () => {
    expect("/api/v1/openclaw/stage").toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
  });

  it("every captured url on the happy path matches the allowlist", async () => {
    const prior = process.env.PFM_WORKSPACE_ID;
    process.env.PFM_WORKSPACE_ID = "ws-001";
    try {
      const urls: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        urls.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof globalThis.fetch;
      await runDispatchStrategyExperiment(
        { strategy_id: "strat-1", experiment_kind: "backtest" },
        { fetchImpl },
      );
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
      }
    } finally {
      if (prior === undefined) {
        delete process.env.PFM_WORKSPACE_ID;
      } else {
        process.env.PFM_WORKSPACE_ID = prior;
      }
    }
  });

  it("rejects an internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/admin/rpc")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects relative-traversal segments inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/openclaw/stage/../admin")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external URL with a valid-looking prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("https://evil.example.com/api/v1/openclaw/stage")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
