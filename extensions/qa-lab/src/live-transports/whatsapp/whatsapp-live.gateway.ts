// QA Lab WhatsApp Gateway RPC operations.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { startQaGatewayRpcClient } from "../../gateway-rpc-client.js";
import type {
  WhatsAppQaGatewayCallContext,
  WhatsAppQaGatewayRuntime,
  WhatsAppQaMessageScenarioContext,
  WhatsAppQaScenarioId,
} from "./whatsapp-live.contracts.js";

function buildWhatsAppQaIdempotencyKey(scenarioId: WhatsAppQaScenarioId, label: string) {
  return `${scenarioId}:${label}:${randomUUID()}`;
}

type WhatsAppQaGatewaySendParams = {
  asVoice?: boolean;
  forceDocument?: boolean;
  label: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  message?: string;
  replyToId?: string;
};

export async function writeWhatsAppQaWorkspaceFixture(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    buffer: Buffer;
    fileName: string;
  },
) {
  const fixtureDir = path.join(context.gatewayWorkspaceDir, ".openclaw", "qa-whatsapp-media");
  await fs.mkdir(fixtureDir, { recursive: true });
  const filePath = path.join(fixtureDir, params.fileName);
  await fs.writeFile(filePath, params.buffer);
  return filePath;
}

export async function callWhatsAppGatewaySend(
  context: WhatsAppQaGatewayCallContext,
  params: WhatsAppQaGatewaySendParams,
) {
  return await context.gateway.call("send", buildWhatsAppGatewaySendRequest(context, params), {
    timeoutMs: 60_000,
  });
}

function buildWhatsAppGatewaySendRequest(
  context: WhatsAppQaGatewayCallContext,
  params: WhatsAppQaGatewaySendParams,
) {
  return {
    accountId: context.sutAccountId,
    agentId: "main",
    channel: "whatsapp",
    idempotencyKey: buildWhatsAppQaIdempotencyKey(context.scenarioId, params.label),
    to: context.gatewayTarget,
    ...(params.message !== undefined ? { message: params.message } : {}),
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaUrls ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.asVoice !== undefined ? { asVoice: params.asVoice } : {}),
    ...(params.forceDocument !== undefined ? { forceDocument: params.forceDocument } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
  };
}

export async function callWhatsAppGatewaySendConcurrently(
  context: WhatsAppQaMessageScenarioContext,
  sends: WhatsAppQaGatewaySendParams[],
) {
  // Each QA RPC client serializes its own requests. Separate clients preserve
  // real Gateway overlap so this probe reaches the shared WhatsApp socket concurrently.
  const connection = resolveWhatsAppGatewayRpcConnection(context.gateway);
  const clients = await Promise.all(
    sends.map(async (send) => ({
      send,
      client: await startQaGatewayRpcClient({
        logs: connection.logs,
        token: connection.token,
        wsUrl: connection.wsUrl,
      }),
    })),
  );
  try {
    await Promise.all(
      clients.map(({ client, send }) =>
        client.request("send", buildWhatsAppGatewaySendRequest(context, send), {
          timeoutMs: 60_000,
        }),
      ),
    );
  } finally {
    await Promise.all(clients.map(({ client }) => client.stop()));
  }
}

function resolveWhatsAppGatewayRpcConnection(gateway: WhatsAppQaGatewayRuntime) {
  if (!gateway.logs || !gateway.token || !gateway.wsUrl) {
    throw new Error("WhatsApp concurrent Gateway probe requires a live RPC connection.");
  }
  return {
    logs: gateway.logs,
    token: gateway.token,
    wsUrl: gateway.wsUrl,
  };
}

export async function callWhatsAppGatewayPoll(
  context: WhatsAppQaGatewayCallContext,
  params: {
    label: string;
    maxSelections?: number;
    options: string[];
    question: string;
  },
) {
  return await context.gateway.call(
    "poll",
    {
      accountId: context.sutAccountId,
      channel: "whatsapp",
      idempotencyKey: buildWhatsAppQaIdempotencyKey(context.scenarioId, params.label),
      maxSelections: params.maxSelections,
      options: params.options,
      question: params.question,
      to: context.gatewayTarget,
    },
    { timeoutMs: 60_000 },
  );
}

export async function callWhatsAppGatewayMessageAction(
  context: WhatsAppQaGatewayCallContext,
  params: {
    action: "react" | "upload-file";
    label: string;
    params: Record<string, unknown>;
  },
) {
  return await context.gateway.call(
    "message.action",
    {
      accountId: context.sutAccountId,
      action: params.action,
      channel: "whatsapp",
      idempotencyKey: buildWhatsAppQaIdempotencyKey(context.scenarioId, params.label),
      params: {
        ...params.params,
        to: context.gatewayTarget,
      },
    },
    { timeoutMs: 60_000 },
  );
}
