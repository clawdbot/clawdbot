import { describe, expect, it, vi } from "vitest";
import { createLocalOneHopFetchDispatcher } from "./one-hop-fetch-dispatcher.js";

describe("createLocalOneHopFetchDispatcher", () => {
  it("delegates one manual-redirect exchange and preserves HTTP responses", async () => {
    const response = new Response("rate limited", { status: 429 });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const dispatcher = createLocalOneHopFetchDispatcher(fetchImpl);
    const signal = new AbortController().signal;

    await expect(
      dispatcher.dispatch({
        url: "https://public.example/resource",
        init: {
          method: "POST",
          redirect: "manual",
          signal,
        },
      }),
    ).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith("https://public.example/resource", {
      method: "POST",
      redirect: "manual",
      signal,
    });
  });

  it("propagates transport failures unchanged", async () => {
    const transportError = new Error("socket closed");
    const dispatcher = createLocalOneHopFetchDispatcher(vi.fn().mockRejectedValue(transportError));

    await expect(
      dispatcher.dispatch({
        url: "https://public.example/resource",
        init: { redirect: "manual" },
      }),
    ).rejects.toBe(transportError);
  });
});
