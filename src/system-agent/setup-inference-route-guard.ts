import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
