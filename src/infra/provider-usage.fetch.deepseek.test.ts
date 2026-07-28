// Covers DeepSeek provider usage fetch parsing.
import { describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchDeepSeekUsage } from "./provider-usage.fetch.deepseek.js";

describe("fetchDeepSeekUsage", () => {
  it("aggregates mixed-currency balance snapshots", async () => {
    const mockFetch = createProviderUsageFetch(async (url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(url).toBe("https://api.deepseek.com/user/balance");
      expect(headers.Authorization).toBe("Bearer deepseek-key");
      expect(headers.Accept).toBe("application/json");
      return makeResponse(200, {
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "1.25",
            granted_balance: "0",
            topped_up_balance: "1.25",
          },
          {
            currency: "CNY",
            total_balance: "42.50",
            granted_balance: "12.00",
            topped_up_balance: "30.50",
          },
        ],
      });
    });

    const result = await fetchDeepSeekUsage("deepseek-key", 5000, mockFetch);

    expect(result).toEqual({
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      billing: [
        { type: "balance", amount: 1.25, unit: "USD" },
        { type: "balance", amount: 42.5, unit: "CNY" },
      ],
      summary: "Balance $1.25 · Balance ¥42.50 · Granted ¥12.00 · Topped up ¥30.50",
    });
  });

  it("formats unknown currencies without assuming a symbol", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        balance_infos: [
          {
            currency: "EUR",
            total_balance: 3,
          },
        ],
      }),
    );

    const result = await fetchDeepSeekUsage("deepseek-key", 5000, mockFetch);

    expect(result.summary).toBe("Balance 3.00 EUR");
    expect(result.billing).toEqual([{ type: "balance", amount: 3, unit: "EUR" }]);
  });

  it("returns HTTP errors for failed balance requests", async () => {
    const response = makeResponse(401, { error: "invalid api key" });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const mockFetch = createProviderUsageFetch(async () => response);

    const result = await fetchDeepSeekUsage("deepseek-key", 5000, mockFetch);

    expect(cancel).toHaveBeenCalledOnce();
    expect(result.error).toBe("HTTP 401");
    expect(result.windows).toHaveLength(0);
    expect(result.summary).toBeUndefined();
  });

  it("returns a stable error when balance data is absent", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, { is_available: true, balance_infos: [] }),
    );

    const result = await fetchDeepSeekUsage("deepseek-key", 5000, mockFetch);

    expect(result.error).toBe("No balance data");
    expect(result.windows).toHaveLength(0);
  });

  it("marks unavailable accounts while keeping the balance summary", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        is_available: false,
        balance_infos: [{ currency: "CNY", total_balance: "0" }],
      }),
    );

    const result = await fetchDeepSeekUsage("deepseek-key", 5000, mockFetch);

    expect(result.summary).toBe("Balance ¥0.00");
    expect(result.plan).toBe("Unavailable");
  });
});
