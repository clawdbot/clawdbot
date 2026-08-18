import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  sameDefaultInferenceRoute,
  type DefaultInferenceRouteProjection,
} from "./inference-route.js";

function withoutAgentIdentity(projection: DefaultInferenceRouteProjection): unknown {
  const agent = isRecord(projection.agent)
    ? { ...projection.agent, id: "<agent>", agentDir: "<agent-dir>" }
    : projection.agent;
  return {
    ...projection,
    route: projection.route
      ? { ...projection.route, agentId: "<agent>", agentDir: "<agent-dir>" }
      : null,
    defaultSelection: { explicitIds: [] },
    ...(agent ? { agent } : {}),
  };
}

export function sameSetupInferenceRoute(
  left: DefaultInferenceRouteProjection,
  right: DefaultInferenceRouteProjection,
  ignoreAgentIdentity: boolean,
): boolean {
  return ignoreAgentIdentity
    ? isDeepStrictEqual(withoutAgentIdentity(left), withoutAgentIdentity(right))
    : sameDefaultInferenceRoute(left, right);
}

export function sameSetupConfiguredRoute(
  left: DefaultInferenceRouteProjection["route"],
  right: DefaultInferenceRouteProjection["route"],
  ignoreAgentIdentity: boolean,
): boolean {
  if (!ignoreAgentIdentity) {
    return isDeepStrictEqual(left, right);
  }
  const normalize = (route: DefaultInferenceRouteProjection["route"]) =>
    route ? { ...route, agentId: "<agent>", agentDir: "<agent-dir>" } : null;
  return isDeepStrictEqual(normalize(left), normalize(right));
}

export function assertSetupTarget(params: {
  config: OpenClawConfig;
  expectedAgentId?: string;
  expectedAgentDir?: string;
  expectedModelRef?: string;
  resolveAgentDir: (config: OpenClawConfig, agentId: string) => string;
  resolveDefaultAgentId: (config: OpenClawConfig) => string;
  resolveDefaultModelForAgent: (params: { cfg: OpenClawConfig; agentId: string }) => {
    provider: string;
    model: string;
  };
}): void {
  const agentId = params.resolveDefaultAgentId(params.config);
  if (params.expectedAgentId && agentId !== params.expectedAgentId) {
    throw new Error("The default agent changed while AI access was being tested. Try setup again.");
  }
  if (
    params.expectedAgentDir &&
    params.resolveAgentDir(params.config, agentId) !== params.expectedAgentDir
  ) {
    throw new Error(
      "The agent credential location changed while AI access was being tested. Try setup again.",
    );
  }
  if (params.expectedModelRef) {
    const current = params.resolveDefaultModelForAgent({ cfg: params.config, agentId });
    if (`${current.provider}/${current.model}` !== params.expectedModelRef) {
      throw new Error(
        "The default model changed while AI access was being tested. Try setup again.",
      );
    }
  }
}
