/**
 * High-level runtime resolver for inbound channel access decisions.
 *
 * Channel plugins should use this subpath for new receive paths. It accepts
 * platform facts, raw allowlists, route descriptors, command facts, and access
 * group config, then returns sender/route/command/activation projections plus
 * the ordered ingress graph.
 */
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorDrainOptions,
  type ChannelIngressMonitorFacts,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressMonitorPayloadCodec,
  type CreateChannelIngressMonitorOptions,
} from "../channels/message/ingress-monitor.js";
export {
  channelIngressRoutes,
  createChannelIngressResolver,
  resolveChannelMessageIngress,
  resolveStableChannelMessageIngress,
} from "../channels/message-access/runtime.js";
export {
  meetsIdentifierAuthentication,
  type IdentifierAuthentication,
} from "../channels/message-access/identifier-authentication.js";
export {
  defineStableChannelIngressIdentity,
  identityEntryAuthenticationClassifier,
} from "../channels/message-access/runtime-identity.js";
export { readChannelIngressStoreAllowFromForDmPolicy } from "../channels/message-access/store-allow-from.js";
export { resolveChannelImplicitMentions } from "../config/implicit-mentions.js";
export type {
  ChannelIngressAccessGroupMembershipResolver,
  ChannelIngressCommandPresetInput,
  ChannelIngressConfigInput,
  ChannelIngressContextBinding,
  ChannelIngressEventPresetInput,
  ChannelIngressIdentityDescriptor,
  ChannelIngressIdentityAlias,
  ChannelIngressIdentityField,
  ChannelIngressIdentitySubjectInput,
  ChannelIngressRouteAccess,
  ChannelIngressRouteDescriptor,
  ChannelIngressResolver,
  ChannelIngressResolverMessageParams,
  ChannelMessageIngressCommandInput,
  CreateChannelIngressResolverParams,
  ResolvedChannelMessageIngress,
  ResolveChannelMessageIngressParams,
  ResolveStableChannelMessageIngressParams,
  StableChannelIngressIdentityParams,
} from "../channels/message-access/runtime-types.js";
export type {
  AccessGroupMembershipFact,
  ChannelIngressDecision,
  ChannelIngressEventInput,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ChannelIngressStateInput,
  IngressReasonCode,
} from "../channels/message-access/types.js";
export type { ResolvedChannelImplicitMentions } from "../config/implicit-mentions.js";

type ChannelIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type StandardRawEventPayload = { version: 1; rawEvent: string };
type StandardRawEventAdmission<TInspection> =
  | { kind: "invalid"; message: string }
  | { kind: "durable" | (null extends TInspection ? "ignored" : never) };
type StandardRawEventIngressOptions<TRaw, TMetadata, TInspection> = Omit<
  CreateChannelIngressMonitorOptions<TRaw, string, StandardRawEventPayload, TMetadata>,
  "admissionMode" | "drain" | "inspect" | "payload" | "pollIntervalMs" | "retention"
> & {
  inspect: (raw: TRaw) => TInspection;
  payload: Omit<
    ChannelIngressMonitorPayloadCodec<TRaw, string, StandardRawEventPayload, TMetadata>,
    "storage" | "version"
  >;
  pollIntervalMs?: number;
  drain?: Omit<ChannelIngressMonitorDrainOptions<StandardRawEventPayload, TMetadata>, "startLimit">;
  classifyAdmissionError: (error: unknown) => string | undefined;
};

/** Version-1 raw events, 500 ms polling, eight deliveries, and standard retention. */
export function createStandardRawEventIngressMonitor<
  TRaw,
  TMetadata,
  TInspection extends ChannelIngressMonitorFacts | null,
>(options: StandardRawEventIngressOptions<TRaw, TMetadata, TInspection>) {
  const { classifyAdmissionError, createStoppedError, drain, payload, pollIntervalMs, ...base } =
    options;
  const stoppedError =
    createStoppedError ?? (() => new Error("Channel ingress monitor is stopped."));
  const monitor = createChannelIngressMonitor({
    ...base,
    inspect: options.inspect,
    payload: { ...payload, storage: "raw-event", version: 1 },
    pollIntervalMs: pollIntervalMs ?? 500,
    retention: "standard",
    drain: { ...drain, startLimit: 8 },
    admissionMode: "while-running",
    createStoppedError: stoppedError,
  });
  return {
    receive: async (raw: TRaw): Promise<StandardRawEventAdmission<TInspection>> => {
      if (!monitor.isRunning()) {
        throw stoppedError();
      }
      let facts: TInspection;
      try {
        facts = options.inspect(raw);
      } catch (error) {
        const message = classifyAdmissionError(error);
        if (message === undefined) {
          throw error;
        }
        return { kind: "invalid", message };
      }
      if (!facts) {
        return { kind: "ignored" } as StandardRawEventAdmission<TInspection>;
      }
      await monitor.admit(raw, { facts });
      return { kind: "durable" };
    },
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}

/** Fan one logical inbound turn's ownership lifecycle across its durable claims. */
export function fanInChannelIngressLifecycles(
  inputs: readonly (ChannelIngressLifecycle | undefined)[],
): {
  lifecycle: ChannelIngressLifecycle | undefined;
  settle: () => Promise<void>;
  abandon: (error?: unknown) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const lifecycles = inputs.filter((lifecycle) => lifecycle !== undefined);
  const first = lifecycles[0];
  if (!first) {
    return {
      lifecycle: undefined,
      settle: async () => {},
      abandon: async () => {},
      cancel: async () => {},
    };
  }

  let handedOff = false;
  const adoptAll = async () => {
    for (const lifecycle of lifecycles) {
      await lifecycle.onAdopted();
    }
  };
  const fanOut = async (invoke: (lifecycle: ChannelIngressLifecycle) => void | Promise<void>) => {
    await Promise.all(lifecycles.map(async (lifecycle) => await invoke(lifecycle)));
  };
  const abandonAll = () => fanOut((lifecycle) => lifecycle.onAbandoned());
  const failAll = (error: unknown) =>
    fanOut((lifecycle) =>
      lifecycle.onFailed ? lifecycle.onFailed(error) : lifecycle.onAbandoned(),
    );
  const supportsCancellation = lifecycles.every((lifecycle) => lifecycle.onCancelled !== undefined);
  // Omit aggregate cancellation unless every durable source supports it. Callers
  // can then use settle/abandon without an acknowledged-but-unsettled claim.
  const cancelAll = () =>
    fanOut((lifecycle) =>
      lifecycle.onCancelled ? lifecycle.onCancelled() : lifecycle.onAbandoned(),
    );
  return {
    lifecycle: {
      abortSignal:
        lifecycles.length === 1
          ? first.abortSignal
          : AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
      onAdopted: async () => {
        handedOff = true;
        await adoptAll();
      },
      onDeferred: () => {
        handedOff = true;
        for (const lifecycle of lifecycles) {
          lifecycle.onDeferred();
        }
      },
      onAdoptionFinalizing: () => {
        for (const lifecycle of lifecycles) {
          lifecycle.onAdoptionFinalizing();
        }
      },
      onFailed: async (error) => {
        handedOff = true;
        await failAll(error);
      },
      ...(supportsCancellation
        ? {
            onCancelled: async () => {
              handedOff = true;
              await cancelAll();
            },
          }
        : {}),
      onAbandoned: async () => {
        handedOff = true;
        await abandonAll();
      },
    },
    // A gated or deliberately skipped turn still consumed every source claim.
    settle: async () => {
      if (!handedOff) {
        await adoptAll();
        handedOff = true;
      }
    },
    abandon: async (error?: unknown) => {
      if (!handedOff) {
        handedOff = true;
        await (error === undefined ? abandonAll() : failAll(error));
      }
    },
    // Source-compatible lifecycles predate onCancelled. Settle each source through
    // its strongest release callback so mixed fan-in cannot strand a durable claim.
    cancel: async () => {
      if (!handedOff) {
        handedOff = true;
        await cancelAll();
      }
    },
  };
}
