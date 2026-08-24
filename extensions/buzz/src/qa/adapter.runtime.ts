import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaBusConversationKind } from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { BuzzInboundMessage } from "../message-event.js";
import { buildBuzzTarget } from "../target.js";
import { parseBuzzQaCredentialPayload, readBuzzQaCredentialFile } from "./credentials.js";
import { createBuzzQaRelayDriver } from "./relay-client.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>> & {
  cleanupAfterGatewayStop?: () => Promise<void>;
};

const BUZZ_GATEWAY_ACCOUNT_ID = "default";
const BUZZ_MESSAGE_ID_MAPPING_TIMEOUT_MS = 5_000;

function isBuzzMention(text: string) {
  return /(^|\s)@openclaw\b/iu.test(text);
}

async function waitForBuzzChannelRunning(params: {
  accountId: string;
  gateway: Parameters<AdapterDefinition["waitReady"]>[0]["gateway"];
  pollIntervalMs?: number;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const startedAt = Date.now();
  let lastStatus: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    const payload = (await params.gateway.call(
      "channels.status",
      { probe: false, timeoutMs: 2_000 },
      { timeoutMs: 5_000 },
    )) as { channelAccounts?: Record<string, Array<Record<string, unknown>>> };
    const status = payload.channelAccounts?.buzz?.find(
      (entry) => entry.accountId === params.accountId,
    );
    lastStatus = status;
    if (status?.running === true && status.restartPending !== true) {
      return;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `buzz account "${params.accountId}" did not become ready; last status: ${JSON.stringify(lastStatus)}`,
  );
}

export async function createBuzzQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const requestedCredentialSource = options.credentialSource?.trim().toLowerCase() || "file";
  if (requestedCredentialSource !== "file" && requestedCredentialSource !== "convex") {
    throw new Error('Buzz QA credential source must be "file" or "convex".');
  }
  const credentialFile = options.credentialFile?.trim();
  if (requestedCredentialSource === "file" && !credentialFile) {
    throw new Error("Buzz QA file credentials require --credential-file <path>.");
  }
  if (requestedCredentialSource === "file" && options.credentialRole?.trim()) {
    throw new Error("Buzz QA --credential-role is only valid with --credential-source convex.");
  }
  if (requestedCredentialSource === "convex" && credentialFile) {
    throw new Error(
      "Buzz QA --credential-file cannot be combined with --credential-source convex.",
    );
  }
  const fileCredentials =
    requestedCredentialSource === "file" && credentialFile
      ? await readBuzzQaCredentialFile({ filePath: credentialFile, repoRoot: options.repoRoot })
      : undefined;
  const lease = await context.credentials.acquire({
    kind: "buzz",
    source: requestedCredentialSource === "convex" ? "convex" : "env",
    role: options.credentialRole,
    resolveEnvPayload: () => {
      if (!fileCredentials) {
        throw new Error("Buzz QA file credentials are unavailable.");
      }
      return fileCredentials;
    },
    parsePayload: parseBuzzQaCredentialPayload,
  });
  const heartbeat = context.credentials.startHeartbeat(lease);
  const credentials = lease.payload;
  const accountId = options.sutAccountId?.trim() || "sut";
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  // QA scenarios own the logical target while Buzz uses one physical group room.
  // Preserve both logical fields so outbound matching sees the conversation it sent.
  let logicalConversationId = credentials.roomId;
  let logicalConversationKind: QaBusConversationKind = "group";
  let relayDriver: Awaited<ReturnType<typeof createBuzzQaRelayDriver>>;

  const resolveBusMessageId = async (nativeId: string | undefined) => {
    if (!nativeId) {
      return undefined;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < BUZZ_MESSAGE_ID_MAPPING_TIMEOUT_MS) {
      const busId = busMessageIds.get(nativeId);
      if (busId) {
        return busId;
      }
      // A fast relay response can arrive before sendInbound records the
      // published event's portable id. Preserve native reply relations until
      // that canonical mapping is available instead of dropping them.
      await sleep(10);
    }
    throw new Error(`Buzz QA could not resolve the portable id for native message ${nativeId}.`);
  };

  const recordOutbound = async (message: BuzzInboundMessage) => {
    const [threadId, replyToId] = await Promise.all([
      resolveBusMessageId(message.threadId),
      resolveBusMessageId(message.replyToId),
    ]);
    const outbound = await context.messages.addOutboundMessage({
      accountId,
      to: `${logicalConversationKind}:${logicalConversationId}`,
      senderId: credentials.sutPublicKey,
      text: message.text,
      timestamp: message.createdAt * 1_000,
      threadId,
      replyToId,
    });
    nativeMessageIds.set(outbound.id, message.id);
    busMessageIds.set(message.id, outbound.id);
  };

  try {
    relayDriver = await createBuzzQaRelayDriver({ credentials, onMessage: recordOutbound });
  } catch (error) {
    try {
      await heartbeat.stop();
    } finally {
      await lease.release();
    }
    throw error;
  }

  return {
    id: "buzz",
    label: "Buzz live",
    accountId,
    requiredPluginIds: ["buzz"],
    supportedActions: [],
    assertTransportHealthy() {
      heartbeat.throwIfFailed();
      relayDriver.assertHealthy();
    },
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      relayDriver.assertHealthy();
      logicalConversationId = input.conversation.id;
      logicalConversationKind = input.conversation.kind;
      const sent = await relayDriver.sendMessage({
        text: input.text,
        mentionSut: isBuzzMention(input.text),
        ...(input.threadId ? { threadId: nativeMessageIds.get(input.threadId) } : {}),
        ...(input.replyToId ? { replyToId: nativeMessageIds.get(input.replyToId) } : {}),
      });
      const inbound = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: credentials.driverPublicKey,
        timestamp: sent.timestamp,
      });
      nativeMessageIds.set(inbound.id, sent.eventId);
      busMessageIds.set(sent.eventId, inbound.id);
      return inbound;
    },
    resetTransport() {
      logicalConversationId = credentials.roomId;
      logicalConversationKind = "group";
      nativeMessageIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      ({
        channels: {
          buzz: {
            enabled: true,
            relayUrl: credentials.relayUrl,
            privateKey: credentials.sutPrivateKey,
            ...(credentials.sutAuthTag ? { authTag: credentials.sutAuthTag } : {}),
            groupPolicy: "allowlist",
            groupAllowFrom: [credentials.driverPublicKey],
            groups: {
              [credentials.roomId]: {
                enabled: true,
                requireMention: options.transportPolicy?.requireGroupMention ?? true,
              },
            },
            defaultTo: buildBuzzTarget(credentials.roomId),
          },
        },
      }) as Pick<OpenClawConfig, "channels" | "messages">,
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await waitForBuzzChannelRunning({
        // Buzz is currently single-account; the QA bus keeps its portable SUT
        // label while Gateway status reports the plugin's canonical account id.
        accountId: BUZZ_GATEWAY_ACCOUNT_ID,
        gateway,
        timeoutMs,
        pollIntervalMs,
      }),
    buildAgentDelivery: () => ({
      channel: "buzz",
      to: buildBuzzTarget(credentials.roomId),
      replyChannel: "buzz",
      replyTo: buildBuzzTarget(credentials.roomId),
    }),
    async handleAction() {
      throw new Error("Buzz live QA adapter does not implement transport actions");
    },
    createReportNotes: () => [
      "Runs through a real authenticated Buzz relay room; credential values are omitted.",
    ],
    async cleanup() {
      await relayDriver.close();
    },
    async cleanupAfterGatewayStop() {
      try {
        await heartbeat.stop();
      } finally {
        await lease.release();
      }
    },
  };
}
