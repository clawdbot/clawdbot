/**
 * @name Managed proxy runtime mutation
 * @description Proxy-related process.env and GLOBAL_AGENT runtime mutations must stay in managed proxy owner scopes.
 * @kind problem
 * @problem.severity error
 * @precision high
 * @id js/openclaw/managed-proxy-runtime-mutation
 * @tags maintainability
 *       security
 *       external/cwe/cwe-441
 */

import javascript

predicate forbiddenEnvKey(string key) {
  key =
    [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "GLOBAL_AGENT_HTTP_PROXY",
      "GLOBAL_AGENT_HTTPS_PROXY",
      "GLOBAL_AGENT_NO_PROXY",
      "GLOBAL_AGENT_FORCE_GLOBAL_AGENT",
      "OPENCLAW_PROXY_ACTIVE",
      "OPENCLAW_PROXY_LOOPBACK_MODE"
    ]
}

predicate forbiddenGlobalAgentKey(string key) { key = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] }

predicate relevantSourceFile(File file) {
  exists(string path |
    path = file.getRelativePath() and
    path.regexpMatch("^(src|extensions)/.*\\.(ts|mts|js|mjs)$") and
    not path.regexpMatch(".*\\.(test|spec)\\.(ts|mts|js|mjs)$") and
    not path.regexpMatch(".*\\.(test-utils|test-harness|e2e-harness)\\.ts$") and
    not path.regexpMatch(".*/test-support/.*") and
    not path.regexpMatch(".*/vendor/.*") and
    not path.regexpMatch(".*\\.min\\.js$") and
    not path.regexpMatch("^extensions/diffs/assets/.*")
  )
}

predicate namedExpr(Expr expr, string name) {
  expr.getUnderlyingValue().(Identifier).getName() = name
}

predicate directProcessEnvExpr(Expr expr) {
  exists(PropAccess access |
    expr.getUnderlyingValue() = access and
    access.getPropertyName() = "env" and
    namedExpr(access.getBase(), "process")
  )
}

predicate envAlias(Variable variable) {
  exists(VariableDeclarator decl |
    decl.getBindingPattern().getAVariable() = variable and
    directProcessEnvExpr(decl.getInit())
  )
  or
  exists(VariableDeclarator decl, ObjectPattern pattern, PropertyPattern property |
    decl.getBindingPattern() = pattern and
    namedExpr(decl.getInit(), "process") and
    property = pattern.getAPropertyPattern() and
    property.getName() = "env" and
    property.getValuePattern().(BindingPattern).getAVariable() = variable
  )
}

predicate processEnvExpr(Expr expr) {
  directProcessEnvExpr(expr)
  or
  exists(VarAccess access |
    expr.getUnderlyingValue() = access and
    envAlias(access.getVariable())
  )
}

predicate stringConst(Variable variable, string value) {
  exists(VariableDeclarator decl |
    decl.getBindingPattern().getAVariable() = variable and
    value = decl.getInit().getStringValue()
  )
}

predicate stringArrayContains(Variable variable, string value) {
  exists(VariableDeclarator decl, ArrayExpr array, Expr element |
    decl.getBindingPattern().getAVariable() = variable and
    decl.getInit().getUnderlyingValue() = array and
    element = array.getAnElement().getUnderlyingValue() and
    value = element.getStringValue()
  )
  or
  exists(VariableDeclarator decl, ArrayExpr array, SpreadElement spread, VarAccess access |
    decl.getBindingPattern().getAVariable() = variable and
    decl.getInit().getUnderlyingValue() = array and
    spread = array.getAnElement().getUnderlyingValue() and
    spread.getOperand().getUnderlyingValue() = access and
    stringArrayContains(access.getVariable(), value)
  )
}

predicate forbiddenEnvLoopVariable(Variable variable) {
  exists(ForOfStmt loop, VarAccess domain, string key |
    variable = loop.getAnIterationVariable() and
    loop.getIterationDomain().getUnderlyingValue() = domain and
    stringArrayContains(domain.getVariable(), key) and
    forbiddenEnvKey(key)
  )
}

predicate envKeyExprForbidden(Expr keyExpr) {
  forbiddenEnvKey(keyExpr.getStringValue())
  or
  exists(VarAccess access, string key |
    keyExpr.getUnderlyingValue() = access and
    stringConst(access.getVariable(), key) and
    forbiddenEnvKey(key)
  )
  or
  exists(VarAccess access |
    keyExpr.getUnderlyingValue() = access and
    forbiddenEnvLoopVariable(access.getVariable())
  )
}

predicate globalAgentKeyExprForbidden(Expr keyExpr) {
  forbiddenGlobalAgentKey(keyExpr.getStringValue())
  or
  exists(VarAccess access, string key |
    keyExpr.getUnderlyingValue() = access and
    stringConst(access.getVariable(), key) and
    forbiddenGlobalAgentKey(key)
  )
}

predicate directGlobalExpr(Expr expr) {
  namedExpr(expr, "global")
  or
  namedExpr(expr, "globalThis")
}

predicate globalAlias(Variable variable) {
  exists(VariableDeclarator decl |
    decl.getBindingPattern().getAVariable() = variable and
    directGlobalExpr(decl.getInit())
  )
}

predicate globalExpr(Expr expr) {
  directGlobalExpr(expr)
  or
  exists(VarAccess access |
    expr.getUnderlyingValue() = access and
    globalAlias(access.getVariable())
  )
}

predicate directGlobalAgentExpr(Expr expr) {
  exists(PropAccess access |
    expr.getUnderlyingValue() = access and
    access.getPropertyName() = "GLOBAL_AGENT" and
    globalExpr(access.getBase())
  )
}

predicate globalAgentAlias(Variable variable) {
  exists(VariableDeclarator decl |
    decl.getBindingPattern().getAVariable() = variable and
    directGlobalAgentExpr(decl.getInit())
  )
}

predicate globalAgentExpr(Expr expr) {
  directGlobalAgentExpr(expr)
  or
  exists(VarAccess access |
    expr.getUnderlyingValue() = access and
    globalAgentAlias(access.getVariable())
  )
}

predicate envMutationTarget(Expr target) {
  exists(PropAccess access |
    target.getUnderlyingReference() = access and
    processEnvExpr(access.getBase()) and
    (
      forbiddenEnvKey(access.getPropertyName())
      or
      envKeyExprForbidden(access.getPropertyNameExpr())
    )
  )
}

predicate globalAgentMutationTarget(Expr target) {
  globalAgentExpr(target)
  or
  exists(PropAccess access |
    target.getUnderlyingReference() = access and
    globalAgentExpr(access.getBase()) and
    (
      forbiddenGlobalAgentKey(access.getPropertyName())
      or
      globalAgentKeyExprForbidden(access.getPropertyNameExpr())
    )
  )
}

predicate objectPropertyWithKey(Expr expr, string key) {
  exists(ObjectExpr object, Property property |
    expr.getUnderlyingValue() = object and
    property = object.getAProperty() and
    property.getName() = key
  )
}

Expr managedProxyRuntimeMutation() {
  exists(Assignment assignment |
    result = assignment and
    (
      envMutationTarget(assignment.getTarget())
      or
      globalAgentMutationTarget(assignment.getTarget())
    )
  )
  or
  exists(DeleteExpr delete |
    result = delete and
    (
      envMutationTarget(delete.getOperand())
      or
      globalAgentMutationTarget(delete.getOperand())
    )
  )
  or
  exists(MethodCallExpr call |
    result = call and
    namedExpr(call.getReceiver(), "Object") and
    call.getMethodName() = "assign" and
    (
      processEnvExpr(call.getArgument(0)) and
      exists(string key |
        forbiddenEnvKey(key) and
        objectPropertyWithKey(call.getArgument(1), key)
      )
      or
      globalAgentExpr(call.getArgument(0)) and
      exists(string key |
        forbiddenGlobalAgentKey(key) and
        objectPropertyWithKey(call.getArgument(1), key)
      )
    )
  )
  or
  exists(MethodCallExpr call |
    result = call and
    namedExpr(call.getReceiver(), "Object") and
    call.getMethodName() = "defineProperty" and
    (
      processEnvExpr(call.getArgument(0)) and
      envKeyExprForbidden(call.getArgument(1))
      or
      globalAgentExpr(call.getArgument(0)) and
      globalAgentKeyExprForbidden(call.getArgument(1))
    )
  )
}

predicate allowedFunctionOwnerScope(Expr mutation, string path, string functionName) {
  exists(Function owner |
    mutation.getFile().getRelativePath() = path and
    owner.getFile() = mutation.getFile() and
    owner.getName() = functionName and
    mutation.getParent*() = owner.getBody()
  )
}

predicate allowedMethodOwnerScope(Expr mutation, string path, string methodName) {
  exists(MethodDeclaration method |
    mutation.getFile().getRelativePath() = path and
    method.getFile() = mutation.getFile() and
    method.getDeclaringType().getName() + "." + method.getName() = methodName and
    mutation.getParent*() = method.getBody().getBody()
  )
}

predicate allowedManagedProxyRuntimeMutation(Expr mutation) {
  allowedFunctionOwnerScope(mutation, "src/infra/net/proxy/proxy-lifecycle.ts", "applyProxyEnv")
  or
  allowedFunctionOwnerScope(mutation, "src/infra/net/proxy/proxy-lifecycle.ts", "restoreProxyEnv")
  or
  allowedFunctionOwnerScope(mutation, "src/infra/net/proxy/proxy-lifecycle.ts",
    "restoreGlobalAgentRuntime")
  or
  allowedFunctionOwnerScope(mutation, "src/infra/net/proxy/proxy-lifecycle.ts",
    "restoreNodeHttpStack")
  or
  allowedFunctionOwnerScope(mutation, "src/infra/net/proxy/proxy-lifecycle.ts",
    "bootstrapNodeHttpStack")
  or
  allowedFunctionOwnerScope(mutation, "src/infra/net/proxy/proxy-lifecycle.ts",
    "writeGlobalAgentNoProxy")
  or
  allowedFunctionOwnerScope(mutation, "src/infra/net/proxy/proxy-lifecycle.ts",
    "disableGlobalAgentProxyForIpv6GatewayLoopback")
  or
  allowedMethodOwnerScope(mutation, "extensions/browser/src/browser/cdp-proxy-bypass.ts",
    "NoProxyLeaseManager.acquire")
  or
  allowedMethodOwnerScope(mutation, "extensions/browser/src/browser/cdp-proxy-bypass.ts",
    "NoProxyLeaseManager.release")
}

from Expr mutation
where
  managedProxyRuntimeMutation() = mutation and
  relevantSourceFile(mutation.getFile()) and
  not allowedManagedProxyRuntimeMutation(mutation)
select mutation,
  "Only managed proxy owner scopes may mutate proxy-related process.env or GLOBAL_AGENT runtime state."
