import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

export function clawMutationAvailable(
  snapshot: ApplicationGatewaySnapshot,
  methods: readonly string[],
): boolean {
  return (
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    methods.every((method) => isGatewayMethodAdvertised(snapshot, method) === true)
  );
}
