import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

type ComfyTestApi = {
  getConfig: (cfg?: unknown) => Record<string, unknown>;
  setFetchGuard: (impl: typeof fetchWithSsrFGuard | null) => void;
};

function getComfyTestApi(): ComfyTestApi {
  const api = Reflect.get(globalThis, Symbol.for("openclaw.comfyTestApi"));
  if (!api) {
    throw new Error("Comfy test API is unavailable");
  }
  return api as ComfyTestApi;
}

export function setComfyFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  getComfyTestApi().setFetchGuard(impl);
}

export function getComfyConfigForTesting(cfg?: unknown): Record<string, unknown> {
  return getComfyTestApi().getConfig(cfg);
}
