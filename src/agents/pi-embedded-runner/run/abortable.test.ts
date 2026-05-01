import { describe, expect, it } from "vitest";
import { abortable } from "./abortable.js";

describe("abortable", () => {
  it("rejects with AbortError when signal aborts before inner settles", async () => {
    const ac = new AbortController();
    const inner = new Promise<void>(() => {});
    const wrapped = abortable(ac.signal, inner);
    ac.abort();
    try {
      await wrapped;
      expect.fail("expected rejection");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("rejects immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const inner = new Promise<void>(() => {});
    await expect(abortable(ac.signal, inner)).rejects.toThrow(/aborted/i);
  });

  it("resolves with inner value when inner settles before abort", async () => {
    const ac = new AbortController();
    await expect(abortable(ac.signal, Promise.resolve(42))).resolves.toBe(42);
  });
});
