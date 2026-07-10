// Control UI tests cover Zod initialization under the Gateway's strict CSP.
import { describe, expect, it, vi } from "vitest";

describe("custom theme Zod initialization", () => {
  it("enables jitless mode before object schemas probe dynamic code", async () => {
    vi.resetModules();
    const { z } = await import("zod");
    const config = z.config();
    const previousJitless = config.jitless;
    delete config.jitless;

    const NativeFunction = globalThis.Function;
    let evalProbeAttempted = false;
    const FunctionProxy = new Proxy(NativeFunction, {
      apply(target, thisArg, args) {
        evalProbeAttempted ||= args.length === 1 && args[0] === "";
        return Reflect.apply(target, thisArg, args);
      },
      construct(target, args, newTarget) {
        evalProbeAttempted ||= args.length === 1 && args[0] === "";
        return Reflect.construct(target, args, newTarget);
      },
    });
    vi.stubGlobal("Function", FunctionProxy);

    try {
      await import("./custom-theme.ts");

      expect(z.config().jitless).toBe(true);
      expect(evalProbeAttempted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      if (previousJitless === undefined) {
        delete config.jitless;
      } else {
        config.jitless = previousJitless;
      }
      vi.resetModules();
    }
  });
});
