import type { DispatcherAwareRequestInit } from "./runtime-fetch.js";

export type OneHopFetchRequest = {
  url: string;
  init: DispatcherAwareRequestInit & { redirect: "manual" };
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
    dispatch: async ({ url, init }) => await fetchImpl(url, init),
  };
}
