/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { settleLitElement } from "./lit-settle.ts";

// A stand-in for Lit's contract: `updateComplete` resolves false when that update
// scheduled another one, and a pending promise chain only advances on a microtask turn.
function fakeElement(params: { cyclesBeforeSettled: number; resolveAfterCycle?: number }) {
  let cycle = 0;
  let chainResolved = false;
  return {
    get updateComplete(): Promise<boolean> {
      cycle += 1;
      const settled = cycle > params.cyclesBeforeSettled && chainResolved;
      return Promise.resolve(settled);
    },
    startChain() {
      // Resolves a few microtask turns later, the way a route loader would.
      void Promise.resolve()
        .then(() => undefined)
        .then(() => {
          chainResolved = true;
        });
    },
    get cycles() {
      return cycle;
    },
  };
}

describe("settleLitElement", () => {
  it("keeps draining while updates schedule further updates", async () => {
    const element = fakeElement({ cyclesBeforeSettled: 7 });
    element.startChain();

    await settleLitElement(element);

    // A fixed five-cycle pump would have returned before cycle 7 with work outstanding.
    expect(element.cycles).toBeGreaterThan(7);
  });

  it("gives pending promise chains a microtask turn before declaring settled", async () => {
    let resolved = false;
    const element = {
      updateComplete: Promise.resolve(true),
    };
    void Promise.resolve().then(() => {
      resolved = true;
    });

    await settleLitElement(element);

    expect(resolved).toBe(true);
  });

  it("throws instead of hanging when an element never settles", async () => {
    const element = { updateComplete: Promise.resolve(false) };

    await expect(settleLitElement(element)).rejects.toThrow("render loop");
  });

  it("drains a deep promise chain that only schedules a render at its end", async () => {
    // The shape the settled check alone cannot see: four inert microtask turns, then work
    // that marks the element dirty. A pump that stopped at the first settled rounds would
    // return before it. Chains deeper than the cycle cap are out of reach by design; see
    // the note in lit-settle.ts.
    let pendingRender = false;
    let rendered = false;
    const element = {
      get updateComplete(): Promise<boolean> {
        if (pendingRender) {
          pendingRender = false;
          rendered = true;
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      },
    };
    let chain = Promise.resolve();
    for (let turn = 0; turn < 4; turn += 1) {
      chain = chain.then(() => undefined);
    }
    void chain.then(() => {
      pendingRender = true;
    });

    await settleLitElement(element);

    expect(rendered).toBe(true);
  });

  it("keeps an unconditional floor of drain rounds for in-flight chains", async () => {
    const updateComplete = vi.fn(() => Promise.resolve(true));
    const element = {
      get updateComplete() {
        return updateComplete();
      },
    };

    await settleLitElement(element);

    // Never drains less than the fixed pump this helper replaced.
    expect(updateComplete).toHaveBeenCalledTimes(5);
  });
});
