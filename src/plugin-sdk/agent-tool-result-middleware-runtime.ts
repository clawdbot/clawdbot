import { acquireAgentToolResultMiddlewareRunner } from "../agents/harness/tool-result-middleware.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";

export { acquireAgentToolResultMiddlewareRunner };

/** @deprecated Acquire a runner and await release() when its callbacks are no longer used. */
export function createAgentToolResultMiddlewareRunner(
  ...params: Parameters<typeof acquireAgentToolResultMiddlewareRunner>
): Pick<ReturnType<typeof acquireAgentToolResultMiddlewareRunner>, "applyToolResultMiddleware"> {
  // Shipped callbacks have no release contract. Capture this exact SDK host;
  // closing it fences old callbacks and joins middleware before disposal.
  return withLegacyPluginSdkResourceScope((_resources, retain, runInHost) => {
    const runner = acquireAgentToolResultMiddlewareRunner(...params);
    retain(runner);
    return {
      async applyToolResultMiddleware(event) {
        return await runInHost(() => runner.applyToolResultMiddleware(event));
      },
    };
  });
}
