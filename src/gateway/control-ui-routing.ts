// Control UI route classifier for base-path and root-mounted SPA serving.
import { isControlUiFocusPath } from "@openclaw/session-url-contract";
import { acceptsControlUiHtmlResponse, isReadHttpMethod } from "./control-ui-http-utils.js";
import {
  classifyGatewayProbePath,
  classifyMcpAppStandalonePath,
  classifyNodeWorkspaceTransferPath,
  classifyWorkerGatewayPath,
} from "./gateway-http-route-contracts.js";

type ControlUiRequestClassification =
  | { kind: "not-control-ui" }
  | { kind: "not-found" }
  | { kind: "redirect"; location: string }
  | { kind: "serve"; spaFallback: boolean };

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

/** Focused presentation namespace used only after plugin routing declines it. */
export function isControlUiFocusDocumentPath(params: {
  basePath: string;
  pathname: string;
}): boolean {
  return isControlUiFocusPath(params.pathname, params.basePath);
}

/** Classify an HTTP request as Control UI serving, redirect, 404, or non-Control-UI. */
export function classifyControlUiRequest(params: {
  basePath: string;
  pathname: string;
  search: string;
  method: string | undefined;
  accept?: string;
}): ControlUiRequestClassification {
  const { basePath, pathname, search, method } = params;
  // SPA fallback owns ambiguous browser reads, while plugin recovery is explicit.
  // Decline only clearly non-HTML Accept values so headerless/wildcard clients keep working.
  const spaFallback =
    isControlUiPluginManagerRequest(params) || acceptsControlUiHtmlResponse(params.accept);
  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      return { kind: "not-found" };
    }
    // Keep probe namespaces outside the root SPA: exact paths reach the probe
    // handler, while malformed variants must not look healthy by serving HTML.
    if (classifyGatewayProbePath(pathname) !== "outside") {
      return { kind: "not-control-ui" };
    }
    // The standalone host owns this namespace when enabled. When disabled or
    // malformed, plugins may still claim it before the final Gateway 404.
    if (classifyMcpAppStandalonePath(pathname) !== "outside") {
      return { kind: "not-control-ui" };
    }
    // Worker admission is upgrade-only; never let the root SPA turn a plain GET
    // or a malformed descendant into an apparently successful HTML response.
    if (classifyWorkerGatewayPath(pathname) !== "outside") {
      return { kind: "not-control-ui" };
    }
    // Node workspace transfers are authenticated core routes. Reserve malformed
    // descendants too, so the SPA never turns a transfer failure into HTML.
    if (classifyNodeWorkspaceTransferPath(pathname) !== "outside") {
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
    if (pathname === "/j" || pathname.startsWith("/j/")) {
      return { kind: "not-control-ui" };
    }
    // Disabled OpenAI-compatible endpoints must return 404, not the SPA HTML.
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      return { kind: "not-control-ui" };
    }
    if (!isReadHttpMethod(method)) {
      return { kind: "not-control-ui" };
    }
    return { kind: "serve", spaFallback };
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
  return { kind: "serve", spaFallback };
}
