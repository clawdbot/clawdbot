import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
// Qa Lab plugin module implements qa transport registry behavior.
import type { QaBusState } from "./bus-state.js";
import {
  createQaChannelTransport,
  QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY,
} from "./qa-channel-transport.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { createQaStateBackedTransportAdapter } from "./qa-transport.js";

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

export type QaTransportAdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;

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
            driver: context.driver,
            messages: {
              addInboundMessage: (input) => context.state.addInboundMessage(input),
              addOutboundMessage: (input) => context.state.addOutboundMessage(input),
              editMessage: (input) => context.state.editMessage(input),
            },
            outputDir: context.outputDir,
          });
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
      let cleanupBeforeGatewayStopComplete = false;
      let cleanupAfterGatewayStopComplete = false;
      const cleanupBeforeGatewayStop = async () => {
        if (cleanupBeforeGatewayStopComplete) {
          return;
        }
        await adapter.cleanup?.();
        cleanupBeforeGatewayStopComplete = true;
      };
      const cleanupAfterGatewayStop = async () => {
        if (cleanupAfterGatewayStopComplete) {
          return;
        }
        await adapter.cleanupAfterGatewayStop?.();
        cleanupAfterGatewayStopComplete = true;
      };
      const cleanupWithoutGateway = async () => {
        const errors: unknown[] = [];
        for (const cleanup of [cleanupBeforeGatewayStop, cleanupAfterGatewayStop]) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
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
