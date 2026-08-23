// Qa Lab plugin module implements manual lane behavior.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import type { QaProviderMode } from "./model-selection.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import { createQaTransportAdapter, type QaTransportId } from "./qa-transport-registry.js";
import { resolveQaGatewayTimeoutWithGraceMs } from "./timer-timeouts.js";

type QaManualLaneParams = {
  repoRoot: string;
  transportId?: QaTransportId;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  message: string;
  timeoutMs?: number;
  replySettleMs?: number;
};

type ManualLaneResult = {
  model: string;
  waited: { status?: string; error?: string };
  reply: string | null;
  watchUrl: string;
};

function normalizeManualLaneCleanupError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatErrorMessage(error));
}

async function stopManualLaneResource(
  resource: { stop: () => Promise<void> | void } | null | undefined,
): Promise<Error | undefined> {
  if (!resource) {
    return undefined;
  }
  try {
    await resource.stop();
    return undefined;
  } catch (error) {
    return normalizeManualLaneCleanupError(error);
  }
}

async function stopManualLaneAuxiliaryResources(resources: {
  lab?: { stop: () => Promise<void> | void };
  mock?: { stop: () => Promise<void> | void } | null;
}): Promise<Error | undefined> {
  const stopTasks = [resources.mock, resources.lab]
    .filter((resource): resource is { stop: () => Promise<void> | void } => Boolean(resource))
    .map((resource) => Promise.resolve().then(() => resource.stop()));
  const results = await Promise.allSettled(stopTasks);
  const failed = results.find((result) => result.status === "rejected");
  return failed ? normalizeManualLaneCleanupError(failed.reason) : undefined;
}

function resolveManualLaneTimeoutMs(params: {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  timeoutMs?: number;
}) {
  if (
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
  ) {
    return params.timeoutMs;
  }
  return resolveQaLiveTurnTimeoutMs(
    {
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
    },
    120_000,
    params.primaryModel,
  );
}

export async function runQaManualLane(params: QaManualLaneParams) {
  const sessionSuffix = params.primaryModel.replace(/[^a-z0-9._-]+/gi, "-");
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let lab: Awaited<ReturnType<typeof startQaLabServer>> | undefined;
  let mock: Awaited<ReturnType<typeof startQaProviderServer>> | undefined;
  let transportCleanupBeforeGatewayStop: (() => Promise<void>) | undefined;
  let transportCleanupAfterGatewayStop: (() => Promise<void>) | undefined;
  let result: ManualLaneResult | undefined;
  let cleanupError: Error | undefined;
  let runError: unknown;

  try {
    lab = await startQaLabServer({
      repoRoot: params.repoRoot,
      embeddedGateway: "disabled",
    });
    const transportFactoryResult = await createQaTransportAdapter({
      channelId: params.transportId ?? "qa-channel",
      driver: params.transportId ?? "qa-channel",
      outputDir: params.repoRoot,
      state: lab.state,
    });
    const transport = transportFactoryResult.adapter;
    transportCleanupBeforeGatewayStop = transportFactoryResult.cleanupBeforeGatewayStop;
    transportCleanupAfterGatewayStop = transportFactoryResult.cleanupAfterGatewayStop;
    mock = await startQaProviderServer(params.providerMode, {
      modelRefs: [params.primaryModel, params.alternateModel],
    });
    gateway = await startQaGatewayChild({
      repoRoot: params.repoRoot,
      providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
      transport,
      transportBaseUrl: lab.listenUrl,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
      controlUiEnabled: false,
    });

    const timeoutMs = resolveManualLaneTimeoutMs({
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      timeoutMs: params.timeoutMs,
    });
    const delivery = transport.buildAgentDelivery({
      target: "dm:qa-operator",
    });
    const started = (await gateway.call(
      "agent",
      {
        idempotencyKey: randomUUID(),
        agentId: "qa",
        sessionKey: `agent:qa:manual:${sessionSuffix}`,
        message: params.message,
        deliver: true,
        channel: delivery.channel,
        to: delivery.to ?? "dm:qa-operator",
        replyChannel: delivery.replyChannel,
        replyTo: delivery.replyTo,
      },
      { timeoutMs: 30_000 },
    )) as { runId?: string };

    if (!started.runId) {
      throw new Error(`agent call did not return a runId: ${JSON.stringify(started)}`);
    }

    const waited = (await gateway.call(
      "agent.wait",
      {
        runId: started.runId,
        timeoutMs,
      },
      { timeoutMs: resolveQaGatewayTimeoutWithGraceMs(timeoutMs) },
    )) as { status?: string; error?: string };

    const replySettleMs = params.replySettleMs ?? 500;
    if (replySettleMs > 0) {
      await sleep(replySettleMs);
    }

    const reply =
      lab.state
        .getSnapshot()
        .messages.findLast(
          (candidate) =>
            candidate.direction === "outbound" && candidate.conversation.id === "qa-operator",
        )?.text ?? null;

    result = {
      model: params.primaryModel,
      waited,
      reply,
      watchUrl: lab.baseUrl,
    };
  } catch (error) {
    runError = error;
  } finally {
    let transportCleanupBeforeError: Error | undefined;
    await transportCleanupBeforeGatewayStop?.().catch((error: unknown) => {
      transportCleanupBeforeError = normalizeManualLaneCleanupError(error);
    });
    const gatewayCleanupError = await stopManualLaneResource(gateway);
    let transportCleanupAfterError: Error | undefined;
    if (!gatewayCleanupError) {
      await transportCleanupAfterGatewayStop?.().catch((error: unknown) => {
        transportCleanupAfterError = normalizeManualLaneCleanupError(error);
      });
    }
    const auxiliaryCleanupError = await stopManualLaneAuxiliaryResources({ lab, mock });
    cleanupError =
      transportCleanupBeforeError ??
      gatewayCleanupError ??
      transportCleanupAfterError ??
      auxiliaryCleanupError;
  }
  if (runError) {
    throw new Error(formatErrorMessage(runError), { cause: runError });
  }
  if (cleanupError) {
    throw cleanupError;
  }

  if (!result) {
    throw new Error("manual lane did not produce a result");
  }
  return result;
}
