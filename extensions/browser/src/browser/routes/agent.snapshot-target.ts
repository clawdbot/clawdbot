import type { RelayOperationReference } from "../extension-relay/owner-client.js";
import type { BrowserRouteContext } from "../server-context.js";
import { getProfileLifecycle } from "../server-context.lifecycle.js";

export type BrowserOperationTargetResolver = (() =>
  | string
  | undefined
  | Promise<string | undefined>) & {
  reference?: RelayOperationReference;
  release: () => Promise<void>;
};

/** Pin capture at the actual bridge; a failed capture must never enable generic recovery. */
export async function captureBrowserOperationTarget(opts: {
  ctx: BrowserRouteContext;
  profileName: string;
  targetId: string;
}): Promise<BrowserOperationTargetResolver | undefined> {
  const state = opts.ctx.state();
  const relay = state.extensionRelays?.get(opts.profileName);
  if (!relay) {
    return undefined;
  }
  const runtime = state.profiles.get(opts.profileName);
  if (!runtime) {
    throw new Error("Browser operation profile is unavailable");
  }
  const lifecycle = getProfileLifecycle(runtime);
  const generation = lifecycle.generation;
  let released = false;
  const isCurrent = () =>
    !released &&
    opts.ctx.state() === state &&
    state.extensionRelays?.get(opts.profileName) === relay &&
    state.profiles.get(opts.profileName) === runtime &&
    lifecycle.generation === generation;
  const reference =
    relay.ownership === "borrowed"
      ? await relay.client.capture(opts.targetId, () => {
          if (!isCurrent()) {
            throw new Error("Browser operation generation was superseded");
          }
        })
      : undefined;
  const resolveTarget =
    relay.ownership === "borrowed"
      ? reference?.resolve
      : relay.bridge.captureOperationTarget(opts.targetId);
  const resolve = async () => {
    if (!isCurrent()) {
      return undefined;
    }
    const target = await resolveTarget?.();
    return isCurrent() ? target : undefined;
  };
  return Object.assign(resolve, {
    reference,
    release: async () => {
      released = true;
      await reference?.release();
    },
  });
}

/** Report the acted-on target if its exact owner no longer exposes a replacement. */
export async function resolveOperationTargetOutcome(opts: {
  actedOnTargetId: string;
  operationTargetId?: string;
  resolveRelayTarget?: () => string | undefined | Promise<string | undefined>;
}): Promise<string> {
  return opts.resolveRelayTarget
    ? ((await opts.resolveRelayTarget()) ?? opts.actedOnTargetId)
    : (opts.operationTargetId ?? opts.actedOnTargetId);
}
