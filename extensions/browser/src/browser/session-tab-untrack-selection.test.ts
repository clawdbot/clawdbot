import { describe, expect, it } from "vitest";
import { selectSessionTabToUntrack } from "./session-tab-untrack-selection.js";

const missing = {
  volatileAvailable: false,
  durableAvailable: false,
  hasVolatileCandidate: false,
  hasDurableCandidate: false,
  volatileIsExact: false,
  durableIsExact: false,
  hasVolatileExactCandidate: false,
  hasDurableExactCandidate: false,
};

describe("session tab untrack selection", () => {
  it.each([
    ["missing candidates", {}, "missing"],
    ["two aliases", { hasVolatileCandidate: true, hasDurableCandidate: true }, "ambiguous"],
    [
      "an exact volatile target over a durable alias",
      {
        volatileAvailable: true,
        durableAvailable: true,
        hasVolatileCandidate: true,
        hasDurableCandidate: true,
        volatileIsExact: true,
      },
      "volatile",
    ],
    [
      "an exact durable target over a volatile alias",
      {
        volatileAvailable: true,
        durableAvailable: true,
        hasVolatileCandidate: true,
        hasDurableCandidate: true,
        durableIsExact: true,
        hasDurableExactCandidate: true,
      },
      "durable",
    ],
    [
      "exact targets in both ownership kinds",
      {
        durableAvailable: true,
        hasVolatileCandidate: true,
        hasDurableCandidate: true,
        durableIsExact: true,
        hasVolatileExactCandidate: true,
        hasDurableExactCandidate: true,
      },
      "ambiguous",
    ],
  ] as const)("selects %s", (_label, state, expected) => {
    expect(selectSessionTabToUntrack({ ...missing, ...state })).toBe(expected);
  });
});
