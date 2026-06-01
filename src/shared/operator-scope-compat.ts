const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_SCOPE_PREFIX = "operator.";

function normalizeScopeList(scopes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return [...out];
}

function operatorScopeSatisfied(requestedScope: string, granted: Set<string>): boolean {
  if (!requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) {
    return false;
  }
  if (granted.has(OPERATOR_ADMIN_SCOPE)) {
    return true;
  }
  if (requestedScope === OPERATOR_READ_SCOPE) {
    return granted.has(OPERATOR_READ_SCOPE) || granted.has(OPERATOR_WRITE_SCOPE);
  }
  if (requestedScope === OPERATOR_WRITE_SCOPE) {
    return granted.has(OPERATOR_WRITE_SCOPE);
  }
  return granted.has(requestedScope);
}

/** Returns true when a role grant satisfies requested scopes, including operator implications. */
export function roleScopesAllow(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): boolean {
  const requested = normalizeScopeList(params.requestedScopes);
  if (requested.length === 0) {
    return true;
  }
  const allowed = normalizeScopeList(params.allowedScopes);
  if (allowed.length === 0) {
    return false;
  }
  const allowedSet = new Set(allowed);
  if (params.role.trim() !== OPERATOR_ROLE) {
    const prefix = `${params.role.trim()}.`;
    return requested.every((scope) => scope.startsWith(prefix) && allowedSet.has(scope));
  }
  return requested.every((scope) => operatorScopeSatisfied(scope, allowedSet));
}

/** Returns the first requested scope not covered by the role's allowed scopes. */
export function resolveMissingRequestedScope(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): string | null {
  for (const scope of params.requestedScopes) {
    if (
      !roleScopesAllow({
        role: params.role,
        requestedScopes: [scope],
        allowedScopes: params.allowedScopes,
      })
    ) {
      return scope;
    }
  }
  return null;
}

/** Returns the first requested scope that does not belong to any requested role. */
export function resolveScopeOutsideRequestedRoles(params: {
  requestedRoles: readonly string[];
  requestedScopes: readonly string[];
}): string | null {
  for (const scope of params.requestedScopes) {
    const matchesRequestedRole = params.requestedRoles.some((role) =>
      roleScopesAllow({
        role,
        requestedScopes: [scope],
        allowedScopes: [scope],
      }),
    );
    if (!matchesRequestedRole) {
      return scope;
    }
  }
  return null;
}
