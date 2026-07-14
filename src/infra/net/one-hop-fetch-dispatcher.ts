import {
  assertLocalNetworkGuardPrepared,
  type NetworkGuardProfileV1,
} from "./network-guard-profile.js";

export type OneHopFetchRequest = {
  url: string;
  init: RequestInit & { redirect: "manual" };
  networkGuard: NetworkGuardProfileV1;
};

export type OneHopFetchDispatcher = {
  dispatch: (request: OneHopFetchRequest) => Promise<Response>;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type LocalOneHopFetch = (url: string, init: OneHopFetchRequest["init"]) => Promise<Response>;

export function createLocalOneHopFetchDispatcher(
  fetchImpl: LocalOneHopFetch,
  options: { hasPreparedDispatcher?: boolean } = {},
): OneHopFetchDispatcher {
  return {
    dispatch: async ({ url, init, networkGuard }) => {
      assertLocalNetworkGuardPrepared({
        profile: networkGuard,
        requestUrl: url,
        hasDispatcher: options.hasPreparedDispatcher === true,
      });
      return await fetchImpl(url, init);
    },
  };
}
