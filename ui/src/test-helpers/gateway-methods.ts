import type { GatewayHelloOk } from "../api/gateway.ts";

export const SESSION_MUTATION_TEST_METHODS = [
  "chat.abort",
  "chat.send",
  "environments.destroy",
  "projects.add",
  "session.members.add",
  "session.members.list",
  "session.members.listEvidence",
  "session.members.remove",
  "session.visibility.set",
  "sessions.assignOwner",
  "sessions.abort",
  "sessions.branches.switch",
  "sessions.catalog.startTerminal",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.create",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.put",
  "sessions.groups.rename",
  "sessions.groups.update",
  "sessions.move",
  "sessions.patch",
  "sessions.patchMany",
  "sessions.reclaim",
  "sessions.recover",
  "sessions.reset",
  "sessions.rewind",
  "worktrees.create",
  "worktrees.remove",
] as const;

export function gatewayHelloForMethods(
  methods: readonly string[],
  scopes: readonly string[] = ["operator.admin"],
): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    features: { methods: [...methods] },
    auth: { role: "operator", scopes: [...scopes] },
  };
}

export function sessionMutationGatewayHello(
  scopes: readonly string[] = ["operator.admin"],
): GatewayHelloOk {
  return gatewayHelloForMethods(SESSION_MUTATION_TEST_METHODS, scopes);
}
