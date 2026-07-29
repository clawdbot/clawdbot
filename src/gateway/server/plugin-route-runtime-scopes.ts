// Plugin route runtime scopes map authenticated HTTP callers to operator scopes exposed inside plugin handlers.
import type { IncomingMessage } from "node:http";
import {
  getHeader,
  resolveTrustedHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
} from "../http-auth-utils.js";
import { CLI_DEFAULT_OPERATOR_SCOPES, WRITE_SCOPE } from "../method-scopes.js";

/**
 * Runtime operator-scope resolver for plugin HTTP route requests.
 */
export type PluginRouteRuntimeScopeSurface = "write-default" | "trusted-operator";

/** Resolves the scopes a plugin route receives after gateway HTTP authentication. */
export function resolvePluginRouteRuntimeOperatorScopes(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
  surface: PluginRouteRuntimeScopeSurface = "write-default",
): string[] {
  if (surface === "trusted-operator") {
    if (!requestAuth.trustDeclaredOperatorScopes) {
      return [...CLI_DEFAULT_OPERATOR_SCOPES];
    }
    return resolveTrustedHttpOperatorScopes(req, requestAuth);
  }
  if (requestAuth.authMethod !== "trusted-proxy") {
    return [WRITE_SCOPE];
  }
  if (getHeader(req, "x-openclaw-scopes") === undefined) {
    // Trusted-proxy callers without an explicit scope header keep the legacy
    // write-default surface instead of inheriting every CLI operator scope.
    return [WRITE_SCOPE];
  }
  return resolveTrustedHttpOperatorScopes(req, requestAuth);
}
