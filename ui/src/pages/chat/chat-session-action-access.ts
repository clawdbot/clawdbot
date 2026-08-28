import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";

export function readChatSessionActionAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  hasLocalRun: boolean,
) {
  return {
    compact: readSessionMethodAccess(snapshot, {
      method: "sessions.compact",
      requiredScope: "operator.admin",
    }),
    abort: readSessionMethodAccess(snapshot, {
      method: hasLocalRun ? "chat.abort" : "sessions.abort",
      requiredScope: "operator.write",
    }),
    rewind: readSessionMethodAccess(snapshot, {
      method: "sessions.rewind",
      requiredScope: "operator.admin",
    }),
    fork: readSessionMethodAccess(snapshot, {
      method: "sessions.fork",
      requiredScope: "operator.write",
    }),
    reset: readSessionMethodAccess(snapshot, {
      method: "sessions.reset",
      requiredScope: "operator.admin",
    }),
    branchSwitch: readSessionMethodAccess(snapshot, {
      method: "sessions.branches.switch",
      requiredScope: "operator.admin",
    }),
  };
}
