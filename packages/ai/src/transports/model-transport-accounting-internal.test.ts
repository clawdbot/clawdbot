import { describe, expect, it, vi } from "vitest";
import { createFetchInvocationCompatibilityObservers } from "./model-transport-accounting-internal.js";

describe("fetch invocation compatibility observers", () => {
  it("retains one invocation from legacy-only hosts", () => {
    const onInvocation = vi.fn();
    const observers = createFetchInvocationCompatibilityObservers(onInvocation);

    observers.onFetchDispatch?.();

    expect(onInvocation).toHaveBeenCalledOnce();
  });

  it("deduplicates hosts that report both per-invocation and legacy callbacks", () => {
    const onInvocation = vi.fn();
    const observers = createFetchInvocationCompatibilityObservers(onInvocation);

    observers.onFetchInvocation?.();
    observers.onFetchDispatch?.();

    expect(onInvocation).toHaveBeenCalledOnce();
  });

  it("retains every redirect invocation before the legacy completion callback", () => {
    const onInvocation = vi.fn();
    const observers = createFetchInvocationCompatibilityObservers(onInvocation);

    observers.onFetchInvocation?.();
    observers.onFetchInvocation?.();
    observers.onFetchDispatch?.();

    expect(onInvocation).toHaveBeenCalledTimes(2);
  });

  it("resets compatibility state for a later legacy-only invocation", () => {
    const onInvocation = vi.fn();
    const observers = createFetchInvocationCompatibilityObservers(onInvocation);

    observers.onFetchInvocation?.();
    observers.onFetchDispatch?.();
    observers.onFetchDispatch?.();

    expect(onInvocation).toHaveBeenCalledTimes(2);
  });
});
