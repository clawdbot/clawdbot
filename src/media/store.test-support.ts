import type { resolvePinnedHostname } from "../infra/net/ssrf.js";
import "./store.js";

type MediaStoreTestApi = {
  setMediaStoreNetworkDepsForTest(deps?: {
    resolvePinnedHostname?: typeof resolvePinnedHostname;
  }): void;
};

function getTestApi(): MediaStoreTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.mediaStoreTestApi")
  ];
  if (!api) {
    throw new Error("media store test API is unavailable");
  }
  return api as MediaStoreTestApi;
}

export function setMediaStoreNetworkDepsForTest(
  deps?: Parameters<MediaStoreTestApi["setMediaStoreNetworkDepsForTest"]>[0],
): void {
  getTestApi().setMediaStoreNetworkDepsForTest(deps);
}
