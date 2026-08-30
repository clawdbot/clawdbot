import type { BrowserRouteContext } from "../server-context.js";

/** Bind relay recovery to the exact registered relay, extension connection, and granted tab. */
export function captureBrowserOperationTarget(opts: {
  ctx: BrowserRouteContext;
  profileName: string;
  targetId: string;
}): (() => string | undefined) | undefined {
  const relay = opts.ctx.state().extensionRelays?.get(opts.profileName);
  if (!relay) {
    return undefined;
  }
  const resolveTarget = relay.bridge.captureOperationTarget(opts.targetId);
  return () =>
    opts.ctx.state().extensionRelays?.get(opts.profileName) === relay
      ? resolveTarget?.()
      : undefined;
}

/** Accept only the acted-on Page or its exact relay-owned tab as a replacement target. */
export function resolveOperationTargetOutcome(opts: {
  actedOnTargetId: string;
  operationTargetId?: string;
  resolveRelayTarget?: () => string | undefined;
}): string {
  return opts.resolveRelayTarget
    ? (opts.resolveRelayTarget() ?? opts.actedOnTargetId)
    : (opts.operationTargetId ?? opts.actedOnTargetId);
}
