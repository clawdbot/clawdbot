// Qa Lab plugin module implements Slack live transport adapter behavior.
import { createSlackWebClient, createSlackWriteClient } from "@openclaw/slack/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { createSlackQaScenarioEnvironment } from "./scenario-environment.js";
import {
  buildSlackQaConfig,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
} from "./slack-live.config.js";
import type { SlackMessage, SlackQaRuntimeEnv } from "./slack-live.contracts.js";
import { waitForSlackChannelStable } from "./slack-live.message-observations.js";
import {
  getSlackIdentity,
  listSlackMessages,
  listSlackThreadMessages,
  sendSlackChannelMessage,
} from "./slack-live.observations.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

async function recordSlackObservedMessage(params: {
  accountId: string;
  busMessageIds: Map<string, string>;
  logicalConversationId: string;
  message: SlackMessage;
  messages: FactoryContext["messages"];
  observedText: Map<string, string>;
  sutUserId: string;
}): Promise<string | undefined> {
  const ts = params.message.ts?.trim();
  if (!ts || params.message.user !== params.sutUserId) {
    return undefined;
  }
  const text = params.message.text ?? "";
  if (params.observedText.get(ts) === text) {
    return undefined;
  }
  params.observedText.set(ts, text);
  const existingMessageId = params.busMessageIds.get(ts);
  if (existingMessageId) {
    await params.messages.editMessage({
      accountId: params.accountId,
      messageId: existingMessageId,
      text,
    });
    return ts;
  }
  const outbound = await params.messages.addOutboundMessage({
    accountId: params.accountId,
    to: `channel:${params.logicalConversationId}`,
    senderId: params.message.user,
    text,
    timestamp: Number(ts.split(".")[0]) * 1_000,
    threadId: params.message.thread_ts
      ? params.busMessageIds.get(params.message.thread_ts)
      : undefined,
  });
  params.busMessageIds.set(ts, outbound.id);
  return ts;
}

export async function createSlackQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const lease = await acquireQaCredentialLease<SlackQaRuntimeEnv>({
    kind: "slack",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => resolveSlackQaRuntimeEnv(),
    parsePayload: parseSlackQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let driverIdentity: Awaited<ReturnType<typeof getSlackIdentity>>;
  let sutIdentity: Awaited<ReturnType<typeof getSlackIdentity>>;
  try {
    [driverIdentity, sutIdentity] = await Promise.all([
      getSlackIdentity(runtimeEnv.driverBotToken),
      getSlackIdentity(runtimeEnv.sutBotToken),
    ]);
    if (driverIdentity.userId === sutIdentity.userId) {
      throw new Error("Slack QA requires two distinct bots for driver and SUT.");
    }
  } catch (error) {
    try {
      await heartbeat.stop();
    } finally {
      await lease.release();
    }
    throw error;
  }
  const driverClient = createSlackWriteClient(runtimeEnv.driverBotToken);
  const sutClient = createSlackWebClient(runtimeEnv.sutBotToken);
  const sutWriteClient = createSlackWriteClient(runtimeEnv.sutBotToken);
  const accountId = options.sutAccountId?.trim() || "sut";
  let oldestTs = `${Math.floor(Date.now() / 1_000)}.000000`;
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = runtimeEnv.channelId;
  const observedText = new Map<string, string>();
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const activeThreadRoots = new Set<string>();
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      const messages = await listSlackMessages({
        channelId: runtimeEnv.channelId,
        client: sutClient,
        oldestTs,
      });
      for (const message of messages.toReversed()) {
        const observedTs = await recordSlackObservedMessage({
          accountId,
          busMessageIds,
          logicalConversationId,
          message,
          messages: context.messages,
          observedText,
          sutUserId: sutIdentity.userId,
        });
        if (observedTs) {
          oldestTs = observedTs;
        }
      }
      for (const threadTs of activeThreadRoots) {
        const threadMessages = await listSlackThreadMessages({
          channelId: runtimeEnv.channelId,
          client: sutClient,
          threadTs,
        });
        for (const message of threadMessages) {
          await recordSlackObservedMessage({
            accountId,
            busMessageIds,
            logicalConversationId,
            message,
            messages: context.messages,
            observedText,
            sutUserId: sutIdentity.userId,
          });
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    id: "slack",
    label: "Slack live",
    accountId,
    requiredPluginIds: ["slack"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
      heartbeat.throwIfFailed();
    },
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      const text = input.text.replaceAll("@openclaw", `<@${sutIdentity.userId}>`);
      const nativeThreadTs = input.threadId ? nativeMessageIds.get(input.threadId) : undefined;
      const sent = await sendSlackChannelMessage({
        channelId: runtimeEnv.channelId,
        client: driverClient,
        text,
        threadTs: nativeThreadTs,
      });
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: driverIdentity.userId,
      });
      nativeMessageIds.set(message.id, sent.ts);
      busMessageIds.set(sent.ts, message.id);
      activeThreadRoots.add(nativeThreadTs ?? sent.ts);
      return message;
    },
    resetTransport: () => {
      logicalConversationId = runtimeEnv.channelId;
      nativeMessageIds.clear();
      busMessageIds.clear();
      activeThreadRoots.clear();
    },
    createGatewayConfig: () =>
      buildSlackQaConfig({} as OpenClawConfig, {
        channelId: runtimeEnv.channelId,
        driverBotUserId: driverIdentity.userId,
        sutAccountId: accountId,
        sutAppToken: runtimeEnv.sutAppToken,
        sutBotToken: runtimeEnv.sutBotToken,
      }),
    prepareFlow: createSlackQaScenarioEnvironment({
      accountId,
      channelId: runtimeEnv.channelId,
      driverBotUserId: driverIdentity.userId,
      driverClient,
      sutAppToken: runtimeEnv.sutAppToken,
      sutBotToken: runtimeEnv.sutBotToken,
      sutIdentity,
      sutReadClient: sutClient,
      sutWriteClient,
    }).prepareFlow,
    waitReady: async ({ gateway }) =>
      await waitForSlackChannelStable(gateway as never, accountId, "connected"),
    buildAgentDelivery: () => ({
      channel: "slack",
      to: `channel:${runtimeEnv.channelId}`,
      replyChannel: "slack",
      replyTo: `channel:${runtimeEnv.channelId}`,
    }),
    async handleAction() {
      throw new Error("Slack live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Runs through the Slack live adapter and shared QA suite host."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      // Lease release must still run when heartbeat shutdown reports an error.
      try {
        await heartbeat.stop();
      } finally {
        await lease.release();
      }
    },
  };
}

export const testing = { recordSlackObservedMessage };
