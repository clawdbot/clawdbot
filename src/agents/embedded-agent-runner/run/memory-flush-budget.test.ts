import { describe, expect, expectTypeOf, it } from "vitest";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import {
  initializeMemoryFlushAppendBudget,
  resolveMemoryFlushAppendEnforcement,
} from "./memory-flush-budget.js";
import type { RunEmbeddedAgentParams } from "./params.js";

describe("memory flush append budget ownership", () => {
  it("allocates exactly one opaque enforcement capability for one logical run", () => {
    const owner = createOperationalRunInstanceRef("memory-flush-budget");

    initializeMemoryFlushAppendBudget(owner);
    const initial = resolveMemoryFlushAppendEnforcement(owner);
    initializeMemoryFlushAppendBudget(owner);

    expect(initial).toBeTypeOf("function");
    expect(resolveMemoryFlushAppendEnforcement(owner)).toBe(initial);
  });

  it("does not expose a mutable budget on public runner params", () => {
    type HasPublicBudget = "memoryFlushAppendBudget" extends keyof RunEmbeddedAgentParams
      ? true
      : false;

    expectTypeOf<HasPublicBudget>().toEqualTypeOf<false>();
  });

  it("isolates concurrent logical runs even when their textual run ids match", async () => {
    const firstOwner = createOperationalRunInstanceRef("same-run-id");
    const secondOwner = createOperationalRunInstanceRef("same-run-id");
    initializeMemoryFlushAppendBudget(firstOwner);
    initializeMemoryFlushAppendBudget(secondOwner);
    const first = resolveMemoryFlushAppendEnforcement(firstOwner);
    const second = resolveMemoryFlushAppendEnforcement(secondOwner);
    if (!first || !second) {
      throw new Error("expected initialized memory-flush enforcement capabilities");
    }

    expect(first).not.toBe(second);
    await Promise.all([
      first({ appendChars: 500, appendedLines: 1, commit: async () => "first" }),
      second({ appendChars: 500, appendedLines: 1, commit: async () => "second" }),
    ]);
    await expect(
      first({ appendChars: 301, appendedLines: 1, commit: async () => "unexpected" }),
    ).rejects.toThrow(/801 chars; max 800/);
    await expect(
      second({ appendChars: 301, appendedLines: 1, commit: async () => "unexpected" }),
    ).rejects.toThrow(/801 chars; max 800/);
  });
});
