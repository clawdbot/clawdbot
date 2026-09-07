import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
// Qa Lab plugin module implements qa transport registry behavior.
import type { QaBusState } from "./bus-state.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "./live-transports/shared/credential-lease.runtime.js";
import {
  createQaChannelTransport,
  QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY,
} from "./qa-channel-transport.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { createQaStateBackedTransportAdapter } from "./qa-transport.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";

export type QaTransportId = "qa-channel";
export type QaTransportDriver = QaTransportId | "crabline" | "live";

export type QaTransportFactoryContext = {
  adapterOptions?: Parameters<
    NonNullable<QaRunnerCliRegistration["adapterFactory"]>["create"]
  >[0]["adapterOptions"];
  channelId: string;
  driver: QaTransportDriver;
  outputDir: string;
  state: QaBusState;
};

export type QaTransportAdapterFactoryResult<
  TAdapter extends QaTransportAdapter = QaTransportAdapter,
> = {
  adapter: TAdapter;
  cleanupBeforeGatewayStop: () => Promise<void>;
  cleanupAfterGatewayStop: () => Promise<void>;
  cleanupWithoutGateway: () => Promise<void>;
};

export type QaTransportAdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]> & {
  prepareSelectedScenarios?: (scenarioIds: readonly string[]) => Promise<void>;
};

export async function prepareQaTransportAdapterFactories(params: {
  factories: readonly QaTransportAdapterFactory[] | undefined;
  driver: QaTransportDriver | undefined;
  cells: readonly QaScenarioExecutionCell[];
}): Promise<readonly QaTransportAdapterFactory[] | undefined> {
  const { factories, driver, cells } = params;
  if (!factories || driver !== "live") {
    return factories;
  }
  return await Promise.all(
    factories.map(async (factory) => {
      if (!factory.prepareSelectedScenarios) {
        return factory;
      }
      const scenarioIds = [
        ...new Set(
          cells.flatMap(({ channel, scenarioId }) =>
            channel &&
            factories.find((candidate) => candidate.matches({ channelId: channel, driver })) ===
              factory
              ? [scenarioId]
              : [],
          ),
        ),
      ];
      if (scenarioIds.length === 0) {
        return factory;
      }
      await factory.prepareSelectedScenarios(scenarioIds);
      // Child partitions carry ready factories, so cold preparation cannot reenter their timers.
      const ready = Object.assign({}, factory);
      delete ready.prepareSelectedScenarios;
      return ready;
    }),
  );
}

type QaTransportAdapterFactoryRegistry = {
  create: (context: QaTransportFactoryContext) => Promise<QaTransportAdapterFactoryResult>;
};

const DEFAULT_QA_TRANSPORT_ID: QaTransportId = "qa-channel";

async function createBuiltInQaTransport(
  context: QaTransportFactoryContext,
): Promise<QaTransportAdapter | undefined> {
  if (context.driver === "qa-channel" && context.channelId === "qa-channel") {
    return createQaChannelTransport(context.state, context.adapterOptions?.transportPolicy);
  }
  if (context.driver === "crabline") {
    const { resolveOpenClawCrablineChannelDriverSelection } = await import("@openclaw/crabline");
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: context.channelId });
    const { createQaCrablineTransportAdapter } = await import("./crabline-transport.js");
    return await createQaCrablineTransportAdapter({
      outputDir: context.outputDir,
      transportPolicy: context.adapterOptions?.transportPolicy,
      selection,
      state: context.state,
    });
  }
  return undefined;
}

function requireQaTransportFactory(
  factories: readonly QaTransportAdapterFactory[],
  context: Pick<QaTransportFactoryContext, "channelId" | "driver">,
) {
  const factory = factories.find((candidate) => candidate.matches(context));
  if (!factory) {
    throw new Error(`no QA transport factory for ${context.driver}:${context.channelId}`);
  }
  return factory;
}

export function qaTransportSupportsModuleFlows(
  factories: readonly QaTransportAdapterFactory[] | undefined,
  context: Pick<QaTransportFactoryContext, "channelId" | "driver">,
): boolean {
  return factories?.find((factory) => factory.matches(context))?.supportsModuleFlows === true;
}

function createQaTransportCleanup(cleanup: () => Promise<void> | undefined): () => Promise<void> {
  let pending: Promise<void> | undefined;

  return () => {
    if (!pending) {
      // Share cleanup across overlapping owners; release failed phases so a
      // later caller can retry instead of leaking a live transport or lease.
      pending = Promise.resolve().then(async () => {
        await cleanup();
      });
      void pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

async function collectQaTransportCleanupErrors(
  cleanups: readonly (() => Promise<void> | undefined)[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function createQaTransportAdapterFactoryRegistry(
  factories: readonly QaTransportAdapterFactory[] = [],
): QaTransportAdapterFactoryRegistry {
  return {
    async create(context) {
      let adapter: QaTransportAdapter;
      try {
        const builtIn = await createBuiltInQaTransport(context);
        if (builtIn) {
          adapter = builtIn;
        } else {
          const factory = requireQaTransportFactory(factories, context);
          const definition = await factory.create({
            adapterOptions: context.adapterOptions,
            channelId: context.channelId,
            credentials: {
              acquire: acquireQaCredentialLease,
              startHeartbeat: startQaCredentialLeaseHeartbeat,
            },
            driver: context.driver,
            messages: {
              addInboundMessage: (input) => context.state.addInboundMessage(input),
              addOutboundMessage: (input) => context.state.addOutboundMessage(input),
              editMessage: (input) => context.state.editMessage(input),
            },
            outputDir: context.outputDir,
          });
          if (factory.supportsModuleFlows && typeof definition.prepareFlow !== "function") {
            const mismatch = new Error(
              `QA transport factory "${factory.id}" supports module flows but its adapter does not implement prepareFlow`,
            );
            const cleanupErrors = await collectQaTransportCleanupErrors([
              () => definition.cleanup?.(),
              () => definition.cleanupAfterGatewayStop?.(),
            ]);
            if (cleanupErrors.length > 0) {
              throw new AggregateError([mismatch, ...cleanupErrors], mismatch.message);
            }
            throw mismatch;
          }
          adapter = createQaStateBackedTransportAdapter(context.state, definition);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `failed to create QA transport ${context.driver}:${context.channelId}: ${message}`,
          {
            cause: error,
          },
        );
      }
      const cleanupBeforeGatewayStop = createQaTransportCleanup(() => adapter.cleanup?.());
      const cleanupAfterGatewayStop = createQaTransportCleanup(() =>
        adapter.cleanupAfterGatewayStop?.(),
      );
      const cleanupWithoutGateway = async () => {
        const errors = await collectQaTransportCleanupErrors([
          cleanupBeforeGatewayStop,
          cleanupAfterGatewayStop,
        ]);
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "QA transport cleanup failed");
        }
      };
      return {
        adapter,
        cleanupBeforeGatewayStop,
        cleanupAfterGatewayStop,
        cleanupWithoutGateway,
      };
    },
  };
}

const qaTransportAdapterFactoryRegistry = createQaTransportAdapterFactoryRegistry();

export function normalizeQaTransportId(input?: string | null): QaTransportId {
  const transportId = input?.trim() || DEFAULT_QA_TRANSPORT_ID;
  if (transportId === "qa-channel") {
    return transportId;
  }
  throw new Error(`unsupported QA transport: ${transportId}`);
}

export function selectQaTransportDriver(params: {
  channelDriver?: QaTransportDriver | null;
  channelDriverSelection?: { channelDriver: QaTransportDriver } | null;
  channelId?: string;
  transportId: QaTransportId;
}): QaTransportDriver {
  const setupDriver = params.channelDriverSelection?.channelDriver;
  if (params.channelDriver && setupDriver && params.channelDriver !== setupDriver) {
    throw new Error(
      `channelDriver=${params.channelDriver} conflicts with adapter setup driver=${setupDriver}`,
    );
  }
  if (setupDriver) {
    return setupDriver;
  }
  if (params.channelDriver === "crabline") {
    throw new Error("channelDriver=crabline requires Crabline adapter setup");
  }
  if (params.channelDriver === "live") {
    return params.channelId ? "live" : params.transportId;
  }
  return params.channelDriver ?? params.transportId;
}

export async function createQaTransportAdapter(
  context: QaTransportFactoryContext,
  factories?: readonly QaTransportAdapterFactory[],
): Promise<QaTransportAdapterFactoryResult> {
  return await (
    factories
      ? createQaTransportAdapterFactoryRegistry(factories)
      : qaTransportAdapterFactoryRegistry
  ).create(context);
}

export function defaultQaSuiteConcurrencyForTransport(id: QaTransportId): number {
  return id === "qa-channel" ? QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY : 1;
}
