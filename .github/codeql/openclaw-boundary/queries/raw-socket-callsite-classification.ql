/**
 * @name Raw socket client callsite classification
 * @description Raw net/tls/http2 client egress must be classified before landing.
 * @kind problem
 * @problem.severity error
 * @precision high
 * @id js/openclaw/raw-socket-callsite-classification
 * @tags maintainability
 *       security
 *       external/cwe/cwe-441
 */

import javascript

predicate rawModule(string moduleName) {
  moduleName = ["net", "node:net", "tls", "node:tls", "http2", "node:http2"]
}

predicate netModule(string moduleName) { moduleName = ["net", "node:net"] }

predicate rawConnectMember(string memberName) { memberName = ["connect", "createConnection"] }

predicate relevantSourceFile(File file) {
  exists(string path |
    path = file.getRelativePath() and
    path.regexpMatch("^(src|extensions)/.*\\.ts$") and
    not path.regexpMatch(".*\\.(test|spec|test-utils|test-harness|e2e-harness)\\.ts$") and
    not path.regexpMatch(".*/test-support/.*") and
    not path.regexpMatch("^extensions/diffs/assets/.*")
  )
}

Expr rawSocketClientCall() {
  exists(API::CallNode call, string moduleName, string memberName |
    rawModule(moduleName) and
    rawConnectMember(memberName) and
    call = API::moduleImport(moduleName).getMember(memberName).getACall() and
    result = call.asExpr()
  )
  or
  exists(string moduleName |
    netModule(moduleName) and
    result =
      DataFlow::moduleMember(moduleName, "Socket")
          .getAnInstantiation()
          .getAMethodCall("connect")
          .asExpr()
  )
}

predicate allowedOwnerScope(Expr call, string path, string functionName) {
  exists(Function owner |
    call.getFile().getRelativePath() = path and
    owner.getFile() = call.getFile() and
    owner.getName() = functionName and
    call.getParent*() = owner.getBody()
  )
}

predicate allowedRawSocketClientCall(Expr call) {
  allowedOwnerScope(call, "src/cli/gateway-cli/run-loop.ts", "waitForGatewayPortReady")
  or
  allowedOwnerScope(call, "src/infra/ssh-tunnel.ts", "canConnectLocal")
  or
  allowedOwnerScope(call, "src/infra/gateway-lock.ts", "checkPortFree")
  or
  allowedOwnerScope(call, "src/infra/jsonl-socket.ts", "requestJsonlSocket")
  or
  allowedOwnerScope(call, "src/infra/net/http-connect-tunnel.ts", "connectToProxy")
  or
  allowedOwnerScope(call, "src/infra/net/http-connect-tunnel.ts", "startTargetTls")
  or
  allowedOwnerScope(call, "src/infra/push-apns-http2.ts", "openProxiedApnsHttp2Session")
  or
  allowedOwnerScope(call, "src/infra/push-apns-http2.ts", "connectApnsHttp2Session")
  or
  allowedOwnerScope(call, "src/proxy-capture/proxy-server.ts", "startDebugProxyServer")
  or
  allowedOwnerScope(call, "extensions/irc/src/client.ts", "connectIrcClient")
  or
  allowedOwnerScope(call, "extensions/qa-lab/src/lab-server-capture.ts", "probeTcpReachability")
  or
  allowedOwnerScope(call, "extensions/qa-lab/src/lab-server-ui.ts", "proxyUpgradeRequest")
}

from Expr call
where
  rawSocketClientCall() = call and
  relevantSourceFile(call.getFile()) and
  not allowedRawSocketClientCall(call)
select call,
  "Classify raw net/tls/http2 client egress as managed/proxied, local-only, diagnostic guarded, or documented unsupported before adding this callsite."
