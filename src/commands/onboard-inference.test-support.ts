import type { LocalCommandProbe } from "../system-agent/probes.js";
import "./onboard-inference.js";

type TestApi = {
  detectNativeCodexAppServer(options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    probeLocalCommand?: (
      command: string,
      args?: string[],
      options?: { timeoutMs?: number },
    ) => Promise<LocalCommandProbe>;
  }): Promise<LocalCommandProbe>;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.onboardInferenceTestApi")
  ] as TestApi;
}

export const detectNativeCodexAppServer: TestApi["detectNativeCodexAppServer"] = (options) =>
  getTestApi().detectNativeCodexAppServer(options);
