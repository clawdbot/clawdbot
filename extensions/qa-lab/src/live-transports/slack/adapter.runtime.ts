// Qa Lab plugin module implements Slack live transport adapter behavior.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { acquireDebugProxyCaptureStore } from "openclaw/plugin-sdk/proxy-capture";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { createSlackQaScenarioEnvironment } from "./scenario-environment.js";
import { getSlackQaMessageWriteCursor, readSlackQaMessageWrites } from "./slack-live.capture.js";
import {
  buildSlackQaConfig,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
} from "./slack-live.config.js";
import type {
  SlackMessage,
  SlackQaFetchFunction,
  SlackQaRuntimeEnv,
} from "./slack-live.contracts.js";
import { waitForSlackChannelStable } from "./slack-live.message-observations.js";
import {
  getSlackIdentity,
  listSlackMessages,
  listSlackThreadMessages,
  sendSlackChannelMessage,
} from "./slack-live.observations.js";
import { loadSlackQaRuntime } from "./slack-plugin.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type FetchFunction = SlackQaFetchFunction;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const SLACK_POLL_INTERVAL_MS = 500;
const SLACK_POLL_REQUEST_TIMEOUT_MS = 10_000;

function resolveSlackRateLimitDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("retryAfter" in error)) {
    return undefined;
  }
  const retryAfter = error.retryAfter;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1_000
    : undefined;
}

async function waitForSlackPoll(delayMs: number, signal: AbortSignal) {
  try {
    await sleep(delayMs, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
}

function withSlackLifecycleSignal(
  fetchImpl: FetchFunction,
  lifecycleSignal: AbortSignal,
): FetchFunction {
  return async (url, init) =>
    await fetchImpl(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, lifecycleSignal]) : lifecycleSignal,
    });
}

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
  const { createSlackWebClient, createSlackWriteClient, resolveSlackWebClientOptions } =
    loadSlackQaRuntime();
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
  let captureStoreLease: ReturnType<typeof acquireDebugProxyCaptureStore> | undefined;
  const captureSessionId = `qa-slack-${randomUUID()}`;
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
  const pollingAbort = new AbortController();
  const pollingOptions = resolveSlackWebClientOptions({
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
    timeout: SLACK_POLL_REQUEST_TIMEOUT_MS,
  });
  pollingOptions.fetch = withSlackLifecycleSignal(
    pollingOptions.fetch ?? globalThis.fetch,
    pollingAbort.signal,
  );
  const pollingClient = createSlackWebClient(runtimeEnv.sutBotToken, pollingOptions);
  const accountId = options.sutAccountId?.trim() || "sut";
  let oldestTs = `${Math.floor(Date.now() / 1_000)}.000000`;
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = runtimeEnv.channelId;
  const observedText = new Map<string, string>();
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const activeThreadRoots = new Set<string>();
  let polling: Promise<void> | undefined;
  const startPolling = () => {
    polling ??= (async () => {
      while (!pollingAbort.signal.aborted) {
        try {
          const messages = await listSlackMessages({
            channelId: runtimeEnv.channelId,
            client: pollingClient,
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
              client: pollingClient,
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
        } catch (error) {
          if (pollingAbort.signal.aborted) {
            return;
          }
          const retryDelayMs = resolveSlackRateLimitDelayMs(error);
          if (retryDelayMs === undefined) {
            throw error;
          }
          await waitForSlackPoll(retryDelayMs, pollingAbort.signal);
          continue;
        }
        await waitForSlackPoll(SLACK_POLL_INTERVAL_MS, pollingAbort.signal);
      }
    })().catch((error: unknown) => {
      if (!stopped) {
        pollingError = toStringifiedError(error);
      }
    });
  };

  const scenarioEnvironment = createSlackQaScenarioEnvironment({
    accountId,
    channelId: runtimeEnv.channelId,
    driverBotUserId: driverIdentity.userId,
    driverClient,
    getMessageWriteCursor: () =>
      captureStoreLease
        ? getSlackQaMessageWriteCursor({
            sessionId: captureSessionId,
            store: captureStoreLease.store,
          })
        : 0,
    readMessageWrites: async (afterRequestEventId) =>
      captureStoreLease
        ? await readSlackQaMessageWrites({
            afterRequestEventId,
            sessionId: captureSessionId,
            store: captureStoreLease.store,
          })
        : [],
    sutAppToken: runtimeEnv.sutAppToken,
    sutBotToken: runtimeEnv.sutBotToken,
    sutIdentity,
    sutReadClient: sutClient,
    sutWriteClient,
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
      // Native Slack scenarios observe their own messages. Start the shared bus
      // observer only when a generic transport flow actually needs it.
      startPolling();
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
    createRuntimeEnvPatch: () => ({
      OPENCLAW_DEBUG_PROXY_ENABLED: "1",
      OPENCLAW_DEBUG_PROXY_SESSION_ID: captureSessionId,
    }),
    prepareFlow: async (input) => {
      captureStoreLease ??= acquireDebugProxyCaptureStore({
        env: (input.gateway as { runtimeEnv: NodeJS.ProcessEnv }).runtimeEnv,
      });
      return await scenarioEnvironment.prepareFlow(input);
    },
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
      // The observer owns its rejection handler, so cancellation must not hold the
      // Gateway shutdown boundary open if the Slack SDK never settles its request.
      pollingAbort.abort();
    },
    async cleanupAfterGatewayStop() {
      // Credential release must still run when capture or heartbeat shutdown reports an error.
      try {
        captureStoreLease?.release();
      } finally {
        try {
          await heartbeat.stop();
        } finally {
          await lease.release();
        }
      }
    },
  };
}

export const testing = {
  recordSlackObservedMessage,
  resolveSlackRateLimitDelayMs,
  withSlackLifecycleSignal,
};
