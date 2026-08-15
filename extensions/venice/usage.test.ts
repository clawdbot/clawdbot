import { describe, expect, it, vi } from "vitest";
import { fetchVeniceUsage } from "./usage.js";

describe("Venice usage", () => {
  it("maps balances and DIEM epoch allocation", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        canConsume: true,
        consumptionCurrency: "diem",
        balances: { diem: "75", usd: 8.5 },
        diemEpochAllocation: "100",
      }),
    );

    const snapshot = await fetchVeniceUsage({
      token: "venice-key",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(snapshot).toEqual({
      provider: "venice",
      displayName: "Venice",
      windows: [{ label: "DIEM epoch", usedPercent: 25 }],
      billing: [
        { type: "balance", label: "DIEM balance", amount: 75, unit: "DIEM" },
        { type: "balance", label: "USD balance", amount: 8.5, unit: "USD" },
        {
          type: "budget",
          label: "DIEM epoch",
          used: 25,
          limit: 100,
          unit: "DIEM",
          period: "epoch",
        },
      ],
      plan: "DIEM billing",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/billing/balance",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer venice-key" },
      }),
    );
  });

  it("preserves unavailable status with balances", async () => {
    const snapshot = await fetchVeniceUsage({
      token: "venice-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async () =>
        Response.json({ canConsume: false, balances: { usd: 0 } }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.summary).toBe("API consumption unavailable");
    expect(snapshot.billing).toEqual([
      { type: "balance", label: "USD balance", amount: 0, unit: "USD" },
    ]);
  });

  it("returns HTTP status without exposing provider error bodies", async () => {
    const snapshot = await fetchVeniceUsage({
      token: "venice-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(
        async () => new Response("private", { status: 403 }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.error).toBe("HTTP 403");
  });

  it("rejects a malformed JSON root without throwing", async () => {
    const snapshot = await fetchVeniceUsage({
      token: "venice-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async () => Response.json(null)) as unknown as typeof fetch,
    });

    expect(snapshot.error).toBe("Malformed usage response");
    expect(snapshot.windows).toEqual([]);
  });

  it("returns a stable error for transport failures", async () => {
    const snapshot = await fetchVeniceUsage({
      token: "venice-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });

    expect(snapshot.error).toBe("Usage unavailable");
    expect(snapshot.windows).toEqual([]);
  });
});
