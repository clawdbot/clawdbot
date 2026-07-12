import {
  assertLocalNetworkGuardPrepared,
  type NetworkGuardProfileV1,
} from "./network-guard-profile.js";
import type { DispatcherAwareRequestInit } from "./runtime-fetch.js";

export type OneHopFetchRequest = {
  url: string;
  init: DispatcherAwareRequestInit & { redirect: "manual" };
  networkGuard: NetworkGuardProfileV1;
};

export type OneHopFetchDispatcher = {
  dispatch: (request: OneHopFetchRequest) => Promise<Response>;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type LocalOneHopFetch = (url: string, init: OneHopFetchRequest["init"]) => Promise<Response>;

export function createLocalOneHopFetchDispatcher(
  fetchImpl: LocalOneHopFetch,
): OneHopFetchDispatcher {
  return {
    dispatch: async ({ url, init, networkGuard }) => {
      assertLocalNetworkGuardPrepared({
        profile: networkGuard,
        requestUrl: url,
        hasDispatcher: Boolean(init.dispatcher),
      });
      return await fetchImpl(url, init);
    },
  };
}
