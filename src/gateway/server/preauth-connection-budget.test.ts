/**
 * Pre-auth WebSocket connection-budget regression tests.
 */
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createPreauthConnectionBudget } from "./preauth-connection-budget.js";

describe("createPreauthConnectionBudget", () => {
  it("caps connections with a finite configured limit", () => {
    const budget = createPreauthConnectionBudget(2);

    expect(budget.acquire("127.0.0.1")).toBe(true);
    expect(budget.acquire("127.0.0.1")).toBe(true);
    expect(budget.acquire("127.0.0.1")).toBe(false);

    budget.release("127.0.0.1");
    expect(budget.acquire("127.0.0.1")).toBe(true);
  });

  it("uses the default cap for non-finite direct limits", () => {
    const budget = createPreauthConnectionBudget(Number.NaN);

    for (let i = 0; i < 32; i += 1) {
      expect(budget.acquire("127.0.0.1")).toBe(true);
    }
    expect(budget.acquire("127.0.0.1")).toBe(false);
  });

  it("shares one capped bucket for missing client IPs", () => {
    const budget = createPreauthConnectionBudget(Number.POSITIVE_INFINITY);

    for (let i = 0; i < 32; i += 1) {
      expect(budget.acquire(i % 2 === 0 ? undefined : "  ")).toBe(true);
    }
    expect(budget.acquire(undefined)).toBe(false);
  });

  it("accepts strict plus-signed env limits", () => {
    withEnv({ OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP: "+02" }, () => {
      const budget = createPreauthConnectionBudget();

      expect(budget.acquire("127.0.0.1")).toBe(true);
      expect(budget.acquire("127.0.0.1")).toBe(true);
      expect(budget.acquire("127.0.0.1")).toBe(false);
    });
  });

  it("ignores non-decimal env limits", () => {
    withEnv({ OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP: "0x2" }, () => {
      const budget = createPreauthConnectionBudget();

      for (let i = 0; i < 32; i += 1) {
        expect(budget.acquire("127.0.0.1")).toBe(true);
      }
      expect(budget.acquire("127.0.0.1")).toBe(false);
    });
  });
});
