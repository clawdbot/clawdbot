import type { BrowserNodeDelegationRequest } from "../registry-contribution-types.js";
import type { PluginRuntime } from "./types.js";

export type BrowserNodeDelegationRuntime = {
  request: (params: BrowserNodeDelegationRequest) => Promise<unknown>;
};

type BrowserNodeDelegationResolver = () => BrowserNodeDelegationRuntime | undefined;

const resolverByRuntime = new WeakMap<object, BrowserNodeDelegationResolver>();

/** Installs a private capability resolver without adding it to PluginRuntime's public shape. */
export function attachBrowserNodeDelegationResolver(
  runtime: object,
  resolver: BrowserNodeDelegationResolver,
): void {
  resolverByRuntime.set(runtime, resolver);
}

/** Resolves the Browser-owned capability for core meeting helpers only. */
export function resolveBrowserNodeDelegationRuntime(
  runtime: PluginRuntime,
): BrowserNodeDelegationRuntime | undefined {
  return resolverByRuntime.get(runtime)?.();
}
