import { describe, expect, it } from "vitest";
import { bindIngressLifecycleToReplyOptions } from "./ingress-drain-lifecycle.js";

describe("channel ingress drain lifecycle", () => {
  it("binds the reply-lane ownership and pre-adoption abort surfaces", async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    const bound = bindIngressLifecycleToReplyOptions({
      abortSignal: abort.signal,
      onAdoptionFinalizing: () => {
        calls.push("finalizing");
      },
      onFailed: () => {
        calls.push("failed");
      },
      onCancelled: () => {
        calls.push("cancelled");
      },
      onAdopted: () => {
        calls.push("adopted");
      },
      onDeferred: () => {
        calls.push("deferred");
      },
      onAbandoned: () => {
        calls.push("abandoned");
      },
    });

    expect(bound.turnAdoptionLifecycle).toMatchObject({
      admission: "exclusive",
      abortSignal: abort.signal,
    });
    expect("onFailed" in bound.turnAdoptionLifecycle).toBe(false);
    expect("onCancelled" in bound.turnAdoptionLifecycle).toBe(false);
    expect("onAdopted" in bound).toBe(false);
    // The top-level abortSignal is the same signal core initial-dispatch
    // cancellation reads (replyOptions.abortSignal); the drain aborts it only
    // pre-adoption, so an adopted run is never cancelled through this surface.
    expect(bound.abortSignal).toBe(abort.signal);
    expect(Object.keys(bound)).toEqual(["abortSignal", "turnAdoptionLifecycle"]);
    bound.turnAdoptionLifecycle.onDeferred();
    await bound.turnAdoptionLifecycle.onAbandoned();
    expect(calls).toEqual(["deferred", "abandoned"]);
    calls.length = 0;
    bound.turnAdoptionLifecycle.onDeferred();
    await bound.turnAdoptionLifecycle.onAdopted();
    expect(calls).toEqual(["deferred", "adopted"]);
  });
});
