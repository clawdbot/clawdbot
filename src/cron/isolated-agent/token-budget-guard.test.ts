import { describe, expect, it, vi } from "vitest";
import { createTokenBudgetGuard } from "./token-budget-guard.js";

describe("createTokenBudgetGuard", () => {
  it("fires once when cumulative usage reaches the budget", () => {
    const onExceeded = vi.fn();
    const guard = createTokenBudgetGuard({ budget: 1_000, onExceeded });

    guard({ total: 400 });
    expect(onExceeded).not.toHaveBeenCalled();

    guard({ total: 1_000 });
    expect(onExceeded).toHaveBeenCalledTimes(1);
    expect(onExceeded).toHaveBeenCalledWith({ total: 1_000 });

    // One-shot: later snapshots never re-fire.
    guard({ total: 2_000 });
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it("never trips on snapshots without a cumulative total", () => {
    const onExceeded = vi.fn();
    const guard = createTokenBudgetGuard({ budget: 1, onExceeded });

    guard({});
    guard({ total: undefined });
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("stays inert once the owning signal has aborted", () => {
    const onExceeded = vi.fn();
    const controller = new AbortController();
    const guard = createTokenBudgetGuard({
      budget: 1,
      onExceeded,
      signal: controller.signal,
    });

    controller.abort();
    guard({ total: 100 });
    expect(onExceeded).not.toHaveBeenCalled();
  });
});
