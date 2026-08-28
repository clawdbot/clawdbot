import type { BrowserNodeDelegation } from "../plugins/registry-contribution-types.js";

export type { BrowserNodeDelegationRequest } from "../plugins/registry-contribution-types.js";

/** Internal registrar installed only on the Browser plugin's host API object. */
export type BrowserNodeDelegationRegistrar = (delegation: BrowserNodeDelegation) => void;

const BROWSER_NODE_DELEGATION_REGISTRAR = "__openclaw_internal_browser_node_delegation_registrar__";

type BrowserNodeDelegationApi = object & {
  [BROWSER_NODE_DELEGATION_REGISTRAR]?: BrowserNodeDelegationRegistrar;
};

/** Attach the host-owned registrar without adding a public Plugin SDK property. */
export function attachBrowserNodeDelegationRegistrar(
  api: object,
  registrar: BrowserNodeDelegationRegistrar,
): void {
  Object.defineProperty(api, BROWSER_NODE_DELEGATION_REGISTRAR, {
    configurable: true,
    enumerable: false,
    value: registrar,
    writable: false,
  });
}

/** Register the Browser-owned capability through the bundled-only host seam. */
export function registerBrowserNodeDelegation(
  api: object,
  delegation: BrowserNodeDelegation,
): void {
  // SAFETY: api is the host-owned object carrying the private registrar seam.
  const registrar = (api as BrowserNodeDelegationApi)[BROWSER_NODE_DELEGATION_REGISTRAR];
  registrar?.(delegation);
}
