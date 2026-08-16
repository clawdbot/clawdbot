import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

export function mergeGatewaySidecarOwners(params: {
  registered: readonly GatewayPostReadySidecarHandle[];
  published: readonly GatewayPostReadySidecarHandle[];
}): GatewayPostReadySidecarHandle[] {
  return [...new Set([...params.registered, ...params.published])];
}
