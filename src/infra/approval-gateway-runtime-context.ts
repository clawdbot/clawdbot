import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayNativeApprovalRuntime } from "./approval-gateway-runtime.types.js";

const APPROVAL_GATEWAY_RUNTIME_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.approvalGatewayRuntimeScope",
);
const approvalGatewayRuntimeScope = resolveGlobalSingleton<
  AsyncLocalStorage<GatewayNativeApprovalRuntime>
>(APPROVAL_GATEWAY_RUNTIME_SCOPE_KEY, () => new AsyncLocalStorage<GatewayNativeApprovalRuntime>());

/** Runs one channel account task with its owning Gateway approval principal. */
export function withGatewayNativeApprovalRuntime<T>(
  runtime: GatewayNativeApprovalRuntime | undefined,
  run: () => T,
): T {
  return runtime ? approvalGatewayRuntimeScope.run(runtime, run) : run();
}

/** Returns the Gateway approval principal for the current channel account task. */
export function getGatewayNativeApprovalRuntime(): GatewayNativeApprovalRuntime | undefined {
  return approvalGatewayRuntimeScope.getStore();
}
