import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

type FalTestApi = {
  setImageFetchGuard: (impl: typeof fetchWithSsrFGuard | null) => void;
  setVideoFetchGuard: (impl: typeof fetchWithSsrFGuard | null) => void;
};

function getFalTestApi(): FalTestApi {
  const api = Reflect.get(globalThis, Symbol.for("openclaw.falTestApi"));
  if (!api) {
    throw new Error("Fal test API is unavailable");
  }
  return api as FalTestApi;
}

export function setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  getFalTestApi().setImageFetchGuard(impl);
}

export function setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  getFalTestApi().setVideoFetchGuard(impl);
}
