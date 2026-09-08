// Role scope checks share operator implications and role-prefix boundaries.
const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_TALK_SCOPE = "operator.talk";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_SCOPE_PREFIX = "operator.";

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
  if (requestedScope === OPERATOR_TALK_SCOPE) {
    return granted.has(OPERATOR_TALK_SCOPE) || granted.has(OPERATOR_WRITE_SCOPE);
  }
  return granted.has(requestedScope);
}

/** Returns true when a role grant satisfies requested scopes, including operator implications. */
export function roleScopesAllow(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): boolean {
  return resolveMissingRequestedScope(params) === null;
}

/** Returns the original first requested scope not covered by the role's allowed scopes. */
export function resolveMissingRequestedScope(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): string | null {
  const role = params.role.trim();
  const prefix = `${role}.`;
  const allowedSet = new Set(params.allowedScopes.map((scope) => scope.trim()));
  for (const scope of params.requestedScopes) {
    const requestedScope = scope.trim();
    if (!requestedScope) {
      continue;
    }
    const satisfied =
      role === OPERATOR_ROLE
        ? operatorScopeSatisfied(requestedScope, allowedSet)
        : requestedScope.startsWith(prefix) && allowedSet.has(requestedScope);
    if (!satisfied) {
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
