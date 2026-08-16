import { afterEach, describe, expect, it } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { resetContextWindowCacheForTest } from "./context-runtime-state.js";

afterEach(() => {
  resetContextWindowCacheForTest();
});

describe("context runtime state", () => {
  it("invalidates a released load marker when the process-global cache is introduced", () => {
    const moduleUrl = new URL("./context-runtime-state.ts", import.meta.url).href;
    const output = execNodeEvalSync(
      `
        const runtimeKey = Symbol.for("openclaw.contextWindowRuntimeState");
        delete globalThis[Symbol.for("openclaw.contextWindowCacheState")];
        const legacyLoadPromise = Promise.resolve();
        globalThis[runtimeKey] = {
          generation: 7,
          loadGeneration: 7,
          loadPromise: legacyLoadPromise,
          configuredConfig: { models: {} },
          configLoadFailures: 0,
          nextConfigLoadAttemptAtMs: 0,
          modelsConfigRuntimeLoader: { clear() {} },
        };
        const { CONTEXT_WINDOW_RUNTIME_STATE: state } = await import(${JSON.stringify(moduleUrl)});
        process.stdout.write([
          state.generation,
          state.loadGeneration === null,
          state.loadPromise === null,
          state.configuredConfig?.models !== undefined,
        ].join(":"));
      `,
      { imports: ["tsx"] },
    );

    expect(output).toBe("7:true:true:true");
  });
});
