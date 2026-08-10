import { describe, expect, it, vi } from "vitest";
import {
  resolveAgentCommandRunAccounting,
  runWithAgentCommandAccounting,
} from "./run-accounting.js";

async function captureFailure(failure: unknown): Promise<{ value: unknown }> {
  let caught: unknown;
  const rejectFailure = vi.fn().mockRejectedValue(failure);
  try {
    await runWithAgentCommandAccounting(async () => await rejectFailure());
  } catch (error) {
    caught = error;
  }
  return { value: caught };
}

function expectAccounting(failure: unknown): void {
  expect(resolveAgentCommandRunAccounting(failure)?.coverage.candidates).toEqual({
    state: "unavailable",
    reasons: ["not_observed"],
  });
}

describe("command run accounting failure identity", () => {
  it("preserves structured and null-prototype object identity", async () => {
    const structuredFailure = {
      code: "EPIPE",
      message: "provider failed",
      status: 503,
    };
    const { value: caughtStructured } = await captureFailure(structuredFailure);
    expect(caughtStructured).toBe(structuredFailure);
    expectAccounting(structuredFailure);

    const nullPrototypeFailure = Object.assign(Object.create(null) as Record<string, unknown>, {
      code: "NULL_PROTO",
    });
    Object.defineProperty(nullPrototypeFailure, "__proto__", {
      enumerable: true,
      value: null,
    });
    const { value: caughtNullPrototype } = await captureFailure(nullPrototypeFailure);
    expect(caughtNullPrototype).toBe(nullPrototypeFailure);
    expectAccounting(nullPrototypeFailure);
  });

  it("preserves hostile proxy and function identity without property access", async () => {
    const hostileFailure = new Proxy(Object.create(null) as object, {
      get() {
        throw new Error("property access failed");
      },
      getPrototypeOf() {
        throw new Error("prototype access failed");
      },
      ownKeys() {
        throw new Error("property enumeration failed");
      },
    });
    const { value: caughtHostile } = await captureFailure(hostileFailure);
    expect(caughtHostile).toBe(hostileFailure);
    expectAccounting(hostileFailure);

    const functionFailure = () => undefined;
    const { value: caughtFunction } = await captureFailure(functionFailure);
    expect(caughtFunction).toBe(functionFailure);
    expectAccounting(functionFailure);
  });

  it.each(["provider exploded", 503, null, undefined, true])(
    "preserves primitive failure identity without attaching accounting: %p",
    async (failure) => {
      const { value: caught } = await captureFailure(failure);
      expect(caught).toBe(failure);
      expect(resolveAgentCommandRunAccounting(failure)).toBeUndefined();
    },
  );
});
