// Control UI route classifier for base-path and root-mounted SPA serving.
import { isReadHttpMethod } from "./control-ui-http-utils.js";

type ControlUiRequestClassification =
  | { kind: "not-control-ui" }
  | { kind: "not-found" }
  | { kind: "redirect"; location: string }
  | { kind: "serve" };

const ROOT_MOUNTED_GATEWAY_PROBE_PATHS = new Set(["/health", "/healthz", "/ready", "/readyz"]);
const CONTROL_UI_PLUGIN_MANAGER_PATH = "/settings/plugins";

/** Keep the plugin recovery surface ahead of plugin-owned HTTP routes. */
export function isControlUiPluginManagerRequest(params: {
  basePath: string;
  pathname: string;
  method: string | undefined;
}): boolean {
  if (!isReadHttpMethod(params.method)) {
    return false;
  }
  const path = `${params.basePath}${CONTROL_UI_PLUGIN_MANAGER_PATH}`;
  return params.pathname === path || params.pathname === `${path}/`;
}

/** Core-owned standalone approval document namespace, before plugin routing. */
export function isControlUiApprovalDocumentPath(params: {
  basePath: string;
  pathname: string;
}): boolean {
  const root = `${params.basePath}/approve`;
  if (params.pathname === root || params.pathname === `${root}/`) {
    return true;
  }
  const prefix = `${root}/`;
  if (!params.pathname.startsWith(prefix)) {
    return false;
  }
  const encodedId = params.pathname.slice(prefix.length);
  return encodedId.length > 0 && !encodedId.includes("/");
}

/** Classify an HTTP request as Control UI serving, redirect, 404, or non-Control-UI. */
export function classifyControlUiRequest(params: {
  basePath: string;
  pathname: string;
  search: string;
  method: string | undefined;
}): ControlUiRequestClassification {
  const { basePath, pathname, search, method } = params;
  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      return { kind: "not-found" };
    }
    // Keep core probe routes outside the root-mounted SPA catch-all so the
    // gateway probe handler can answer them even when the Control UI owns `/`.
    if (ROOT_MOUNTED_GATEWAY_PROBE_PATHS.has(pathname)) {
      return { kind: "not-control-ui" };
    }
    // Keep plugin-owned HTTP routes outside the root-mounted Control UI SPA
    // fallback so untrusted plugins cannot claim arbitrary UI paths.
    if (pathname === "/plugins" || pathname.startsWith("/plugins/")) {
      return { kind: "not-control-ui" };
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return { kind: "not-control-ui" };
    }
    if (!isReadHttpMethod(method)) {
      return { kind: "not-control-ui" };
    }
    return { kind: "serve" };
  }

  if (!pathname.startsWith(`${basePath}/`) && pathname !== basePath) {
    return { kind: "not-control-ui" };
  }
  if (!isReadHttpMethod(method)) {
    return { kind: "not-control-ui" };
  }
  if (pathname === basePath) {
    return { kind: "redirect", location: `${basePath}/${search}` };
  }
  return { kind: "serve" };
}
