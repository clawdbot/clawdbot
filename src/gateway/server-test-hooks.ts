/** Test-only hooks injected by an in-process QA harness. */

export type GatewayStartupTestHooks = {
  beforeWorkerEnvironmentRuntimeStart?: () => void;
};

let gatewayStartupTestHooks: GatewayStartupTestHooks | undefined;

export function registerGatewayStartupTestHooks(hooks: GatewayStartupTestHooks): void {
  gatewayStartupTestHooks = hooks;
}

export function getGatewayStartupTestHooks(): GatewayStartupTestHooks {
  return gatewayStartupTestHooks ?? {};
}
