/**
 * Gateway method and scope constants for browser proxy requests.
 *
 * Node-hosted browser control uses these values on both sides of the gateway
 * contract, so keep them as literal exports instead of duplicated strings.
 */
export const BROWSER_REQUEST_GATEWAY_METHOD = "browser.request" as const;
/** Admin scope required to proxy browser-control requests through Gateway. */
export const BROWSER_REQUEST_GATEWAY_SCOPE = "operator.admin" as const;
/** Scope tuple shape consumed by Gateway tool registration. */
export const BROWSER_REQUEST_GATEWAY_SCOPES = [BROWSER_REQUEST_GATEWAY_SCOPE] as const;
