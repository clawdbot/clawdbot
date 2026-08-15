import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  resolveContinuationRuntimeConfig,
} from "./subagent-announce.runtime.js";

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("../registry/subagent-registry-runtime.js"),
);
const subagentContinuationRuntimeLoader = createLazyImportLoader(
  () => import("../../subagent-announce.continuation.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

export function loadSubagentContinuationRuntime() {
  return subagentContinuationRuntimeLoader.load();
}

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
  resolveContinuationRuntimeConfig: typeof resolveContinuationRuntimeConfig;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  loadSubagentRegistryRuntime,
  resolveContinuationRuntimeConfig,
};

export let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

export const testing = {
  setDepsForTest(
    overrides?: Partial<SubagentAnnounceDeps> & {
      callGateway?: typeof callGateway;
    },
  ) {
    const callGatewayOverride = overrides?.callGateway;
    const dispatchGatewayMethodInProcessOverride =
      overrides?.dispatchGatewayMethodInProcess ??
      (callGatewayOverride
        ? ((async (method, agentParams, options) =>
            await callGatewayOverride({
              method,
              params: agentParams,
              expectFinal: options?.expectFinal,
              timeoutMs: options?.timeoutMs,
            })) satisfies typeof dispatchGatewayMethodInProcess)
        : undefined);
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
          ...(dispatchGatewayMethodInProcessOverride
            ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
            : {}),
        }
      : defaultSubagentAnnounceDeps;
  },
};
