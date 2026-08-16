import { registerGatewayStartupTestHooks } from "../../../../src/gateway/server-test-hooks.js";

registerGatewayStartupTestHooks({
  beforeWorkerEnvironmentRuntimeStart: () => {
    throw new Error("QA worker environment sidecar failure sentinel");
  },
});
