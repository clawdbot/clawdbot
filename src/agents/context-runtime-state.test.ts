import { afterEach, describe, expect, it } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { resetContextWindowCacheForTest } from "./context-runtime-state.js";

afterEach(() => {
  resetContextWindowCacheForTest();
});

describe("context runtime state", () => {
  it("normalizes the singleton shape held by a released gateway", () => {
    const moduleUrl = new URL("./context-runtime-state.ts", import.meta.url).href;
    const output = execNodeEvalSync(
      `
        const key = Symbol.for("openclaw.contextWindowRuntimeState");
        const legacyLoadPromise = Promise.resolve();
        globalThis[key] = {
          loadPromise: legacyLoadPromise,
          configuredConfig: undefined,
          configLoadFailures: 0,
          nextConfigLoadAttemptAtMs: 0,
          modelsConfigRuntimeLoader: { clear() {} },
        };
        const { CONTEXT_WINDOW_RUNTIME_STATE: state } = await import(${JSON.stringify(moduleUrl)});
        process.stdout.write([
          state.generation,
          state.loadGeneration === null,
          state.loadPromise === legacyLoadPromise,
        ].join(":"));
      `,
      { imports: ["tsx"] },
    );

    expect(output).toBe("0:true:true");
  });
});
