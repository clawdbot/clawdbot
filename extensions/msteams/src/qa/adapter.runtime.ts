import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  reserveMSTeamsQaWebhookPort,
  startMSTeamsQaBotFrameworkServer,
} from "./bot-framework-server.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const SERVICE_URL = "https://smba.trafficmanager.net/qa";
const APP_ID = "qa-msteams-app";
const TENANT_ID = "qa-msteams-tenant";
const DRIVER_ID = "qa-msteams-driver";
const DRIVER_AAD_OBJECT_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_ID = "qa-msteams-team";
const TEAM_AAD_GROUP_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_ACCOUNT_ID = "default";

function nativeConversationId(logicalId: string) {
  return logicalId.startsWith("19:") ? logicalId : `19:${logicalId}@thread.tacv2`;
}

function renderMSTeamsQaText(text: string) {
  const mentionText = "<at>openclaw</at>";
  const renderedText = text.replace(/@openclaw\b/giu, mentionText);
  return {
    text: renderedText,
    ...(renderedText === text
      ? {}
      : {
          entities: [
            {
              type: "mention",
              text: mentionText,
              mentioned: { id: APP_ID, name: "OpenClaw QA" },
            },
          ],
        }),
  };
}

function activityText(activity: Record<string, unknown>) {
  return typeof activity.text === "string" ? activity.text : "";
}

function createMSTeamsQaBotToken() {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  // Teams SDK decodes custom tokens before attaching them to Connector requests.
  // This unsigned value is accepted only by the nonce-protected loopback server.
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ appid: APP_ID, jti: randomUUID(), tid: TENANT_ID }),
    "qa",
  ].join(".");
}

async function waitForMSTeamsChannelReady(
  gateway: Parameters<AdapterDefinition["waitReady"]>[0]["gateway"],
  timeoutMs = 60_000,
  pollIntervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastAccounts: unknown;
  while (Date.now() < deadline) {
    const payload = (await gateway.call(
      "channels.status",
      { probe: false, timeoutMs: 2_000 },
      { timeoutMs: 5_000 },
    )) as {
      channelAccounts?: Record<string, Array<Record<string, unknown>>>;
    };
    const accounts = payload.channelAccounts?.msteams ?? [];
    lastAccounts = accounts;
    const account = accounts.find((entry) => entry.accountId === DEFAULT_ACCOUNT_ID);
    if (account?.running === true && account.restartPending !== true) {
      return;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`msteams did not become ready; last accounts: ${JSON.stringify(lastAccounts)}`);
}

export async function createMSTeamsQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const accountId = context.adapterOptions?.sutAccountId?.trim() || DEFAULT_ACCOUNT_ID;
  const webhookPort = await reserveMSTeamsQaWebhookPort();
  const nonce = randomUUID();
  const botToken = createMSTeamsQaBotToken();
  const bootstrapPath = path.join(context.outputDir, ".msteams-private-qa-bootstrap.mjs");
  const busByNativeMessageId = new Map<string, string>();
  const nativeByBusMessageId = new Map<string, string>();
  const conversationKindByNativeId = new Map<string, "channel" | "direct" | "group">();
  const logicalConversationByNativeId = new Map<string, string>();
  const requireGroupMention = context.adapterOptions?.transportPolicy?.requireGroupMention === true;
  const connector = await startMSTeamsQaBotFrameworkServer({
    botToken,
    nonce,
    async onOutbound(outbound) {
      const kind = conversationKindByNativeId.get(outbound.conversationId) ?? "channel";
      const conversationId =
        logicalConversationByNativeId.get(outbound.conversationId) ?? outbound.conversationId;
      const message = await context.messages.addOutboundMessage({
        accountId,
        to: `${kind === "direct" ? "dm" : kind}:${conversationId}`,
        senderId: APP_ID,
        text: activityText(outbound.activity),
        timestamp: Date.now(),
        ...(outbound.threadId
          ? { threadId: busByNativeMessageId.get(outbound.threadId) ?? outbound.threadId }
          : {}),
      });
      nativeByBusMessageId.set(message.id, outbound.activityId);
      busByNativeMessageId.set(outbound.activityId, message.id);
      conversationKindByNativeId.set(outbound.conversationId, kind);
    },
  });
  try {
    await fs.mkdir(context.outputDir, { recursive: true });
    await fs.writeFile(
      bootstrapPath,
      [
        'const key = Symbol.for("openclaw.msteams.privateQaRuntime");',
        `globalThis[key] = ${JSON.stringify({
          connectorUrl: connector.baseUrl,
          nonce,
          botToken,
        })};`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    await connector.close().catch(() => undefined);
    throw error;
  }

  return {
    id: "msteams",
    label: "Microsoft Teams live",
    accountId,
    requiredPluginIds: ["msteams"],
    supportedActions: [],
    async sendInbound(input) {
      const conversationId = nativeConversationId(input.conversation.id);
      const nativeThreadId = input.threadId
        ? (nativeByBusMessageId.get(input.threadId) ?? input.threadId)
        : undefined;
      conversationKindByNativeId.set(conversationId, input.conversation.kind);
      logicalConversationByNativeId.set(conversationId, input.conversation.id);
      const activityId = `qa-inbound-${randomUUID()}`;
      const rendered = renderMSTeamsQaText(input.text);
      const activity = {
        id: activityId,
        type: "message",
        ...rendered,
        timestamp: new Date().toISOString(),
        channelId: "msteams",
        serviceUrl: SERVICE_URL,
        from: {
          id: DRIVER_ID,
          aadObjectId: DRIVER_AAD_OBJECT_ID,
          name: input.senderName ?? "Teams QA Driver",
        },
        recipient: { id: APP_ID, name: "OpenClaw QA" },
        conversation: {
          id: nativeThreadId ? `${conversationId};messageid=${nativeThreadId}` : conversationId,
          conversationType:
            input.conversation.kind === "direct"
              ? "personal"
              : input.conversation.kind === "group"
                ? "groupChat"
                : "channel",
          tenantId: TENANT_ID,
        },
        ...(input.replyToId ? { replyToId: input.replyToId } : {}),
        channelData: {
          tenant: { id: TENANT_ID },
          team: { id: TEAM_ID, aadGroupId: TEAM_AAD_GROUP_ID },
          channel: { id: conversationId },
        },
      };
      const webhookUrl = `http://127.0.0.1:${webhookPort}/api/messages`;
      const { response, release } = await fetchWithSsrFGuard({
        url: webhookUrl,
        init: {
          method: "POST",
          headers: {
            authorization: "Bearer private-qa",
            "content-type": "application/json",
          },
          body: JSON.stringify(activity),
        },
        policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(webhookUrl),
        maxRedirects: 0,
        auditContext: "msteams-private-qa-ingress",
      });
      try {
        await response.text();
        if (!response.ok) {
          throw new Error(`Microsoft Teams QA ingress returned HTTP ${response.status}`);
        }
      } finally {
        await release();
      }
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: DRIVER_ID,
      });
      nativeByBusMessageId.set(message.id, activityId);
      busByNativeMessageId.set(activityId, message.id);
      return message;
    },
    resetTransport() {
      busByNativeMessageId.clear();
      nativeByBusMessageId.clear();
      conversationKindByNativeId.clear();
      logicalConversationByNativeId.clear();
    },
    createGatewayConfig: () =>
      ({
        channels: {
          msteams: {
            enabled: true,
            appId: APP_ID,
            appPassword: "private-qa-secret",
            tenantId: TENANT_ID,
            dmPolicy: "allowlist",
            allowFrom: [DRIVER_AAD_OBJECT_ID],
            groupPolicy: "open",
            requireMention: requireGroupMention,
            replyStyle: "thread",
            webhook: { port: webhookPort, path: "/api/messages" },
          },
        },
      }) as Pick<OpenClawConfig, "channels" | "messages">,
    createRuntimeEnvPatch: () => ({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS?.trim(),
        `--import=${pathToFileURL(bootstrapPath).href}`,
      ]
        .filter(Boolean)
        .join(" "),
    }),
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await waitForMSTeamsChannelReady(gateway, timeoutMs, pollIntervalMs),
    buildAgentDelivery: ({ target }) => ({
      channel: "msteams",
      to: target,
      replyChannel: "msteams",
      replyTo: target,
    }),
    async handleAction() {
      throw new Error("Microsoft Teams live QA adapter does not implement transport actions");
    },
    createReportNotes: () => [
      "Uses a loopback Bot Framework Connector with the real Microsoft Teams plugin and Gateway.",
    ],
    async cleanup() {
      try {
        await connector.close();
      } finally {
        await fs.rm(bootstrapPath, { force: true });
      }
    },
  };
}
