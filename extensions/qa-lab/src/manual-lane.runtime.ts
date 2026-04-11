import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";

type QaManualLaneParams = {
  repoRoot: string;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  message: string;
  timeoutMs?: number;
};

function resolveManualLaneTimeoutMs(params: {
  providerMode: "mock-openai" | "live-frontier";
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
  const lab = await startQaLabServer({
    repoRoot: params.repoRoot,
    embeddedGateway: "disabled",
  });
  const mock =
    params.providerMode === "mock-openai"
      ? await startQaMockOpenAiServer({
          host: "127.0.0.1",
          port: 0,
        })
      : null;
  const gateway = await startQaGatewayChild({
    repoRoot: params.repoRoot,
    providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
    qaBusBaseUrl: lab.listenUrl,
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
  try {
    const started = (await gateway.call(
      "agent",
      {
        idempotencyKey: randomUUID(),
        agentId: "qa",
        sessionKey: `agent:qa:manual:${sessionSuffix}`,
        message: params.message,
        deliver: true,
        channel: "qa-channel",
        to: "dm:qa-operator",
        replyChannel: "qa-channel",
        replyTo: "dm:qa-operator",
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
      { timeoutMs: timeoutMs + 5_000 },
    )) as { status?: string; error?: string };

    await sleep(500);

    const reply =
      lab.state
        .getSnapshot()
        .messages.findLast(
          (candidate) =>
            candidate.direction === "outbound" && candidate.conversation.id === "qa-operator",
        )?.text ?? null;

    return {
      model: params.primaryModel,
      waited,
      reply,
      watchUrl: lab.baseUrl,
    };
  } catch (error) {
    throw new Error(formatErrorMessage(error), { cause: error });
  } finally {
    await gateway.stop();
    await mock?.stop();
    await lab.stop();
  }
}
