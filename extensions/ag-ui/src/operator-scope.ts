import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";

/** Operator scope required to start an agent run from the gateway route. */
const OPERATOR_WRITE_SCOPE = "operator.write";
/**
 * Admin satisfies every `operator.*` scope — a documented contract
 * (docs/gateway/operator-scopes.md) that core applies in
 * `authorizeOperatorScopesForRequiredScope` (src/gateway/method-scopes.ts).
 * Without it an admin-only proxy would be refused a turn it is entitled to.
 */
const OPERATOR_ADMIN_SCOPE = "operator.admin";

/**
 * Whether the gateway-authenticated caller may perform write operations.
 *
 * The route is registered `gatewayRuntimeScopeSurface: "write-default"`, which
 * RESOLVES the caller's scopes — it does not enforce them. A trusted proxy that
 * sends an explicit `x-openclaw-scopes` header keeps its declared scopes (see
 * resolvePluginRouteRuntimeOperatorScopes in
 * src/gateway/server/plugin-route-runtime-scopes.ts), so a read-only proxy
 * arrives here authenticated but unentitled. Absent a scope list we fail closed.
 */
export function hasOperatorWriteScope(): boolean {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes;
  return (
    Array.isArray(scopes) &&
    (scopes.includes(OPERATOR_WRITE_SCOPE) || scopes.includes(OPERATOR_ADMIN_SCOPE))
  );
}
