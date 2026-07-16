// Qa Lab plugin module implements WhatsApp live transport adapter behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { WhatsAppQaDriverSession } from "@openclaw/whatsapp/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildQaTarget } from "openclaw/plugin-sdk/qa-channel";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import {
  buildWhatsAppQaConfig,
  parseWhatsAppQaCredentialPayload,
  resolveWhatsAppQaRuntimeEnv,
} from "./whatsapp-live.config.js";
import {
  resolveWhatsAppQaMessageTargets,
  type WhatsAppQaRuntimeEnv,
} from "./whatsapp-live.contracts.js";
import { startWhatsAppQaDriverSessionWithRetry } from "./whatsapp-live.driver.js";
import { unpackWhatsAppAuthArchive, waitForWhatsAppChannelStable } from "./whatsapp-live.setup.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

export async function createWhatsAppQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const lease = await acquireQaCredentialLease<WhatsAppQaRuntimeEnv>({
    kind: "whatsapp",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => resolveWhatsAppQaRuntimeEnv(),
    parsePayload: parseWhatsAppQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let authRoot: string | undefined;
  let driver: WhatsAppQaDriverSession | undefined;
  let driverAuthDir: string;
  let sutAuthDir: string;
  try {
    authRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-whatsapp-qa-adapter-"),
    );
    const [unpackedDriverAuthDir, unpackedSutAuthDir] = await Promise.all([
      unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.driverAuthArchiveBase64,
        clearSignalSessions: true,
        label: "driver-auth",
        parentDir: authRoot,
      }),
      unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.sutAuthArchiveBase64,
        clearSignalSessions: true,
        label: "sut-auth",
        parentDir: authRoot,
      }),
    ]);
    driverAuthDir = unpackedDriverAuthDir;
    sutAuthDir = unpackedSutAuthDir;
    driver = await startWhatsAppQaDriverSessionWithRetry({ authDir: driverAuthDir });
  } catch (error) {
    try {
      await driver?.close().catch(() => undefined);
      await heartbeat.stop();
    } finally {
      try {
        await lease.release();
      } finally {
        if (authRoot) {
          await fs.rm(authRoot, { force: true, recursive: true });
        }
      }
    }
    throw error;
  }
  const getDriver = () => {
    if (!driver) {
      throw new Error("WhatsApp QA driver is not active");
    }
    return driver;
  };
  const accountId = options.sutAccountId?.trim() || "sut";
  const dmTargets = resolveWhatsAppQaMessageTargets({
    driverPhoneE164: runtimeEnv.driverPhoneE164,
    scenarioTarget: "dm",
    sutPhoneE164: runtimeEnv.sutPhoneE164,
  });
  let observedCount = getDriver().getObservedMessages().length;
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = dmTargets.gatewayTarget;
  let logicalConversationKind: "direct" | "group" = "direct";
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      const messages = getDriver().getObservedMessages();
      for (const message of messages.slice(observedCount)) {
        observedCount += 1;
        if (message.fromPhoneE164 !== runtimeEnv.sutPhoneE164) {
          continue;
        }
        await context.messages.addOutboundMessage({
          accountId,
          to: buildQaTarget({
            chatType: logicalConversationKind,
            conversationId: logicalConversationId,
          }),
          senderId: message.fromPhoneE164,
          text: message.text,
          timestamp: Date.parse(message.observedAt),
          replyToId: message.quoted?.messageId
            ? busMessageIds.get(message.quoted.messageId)
            : undefined,
        });
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
    id: "whatsapp",
    label: "WhatsApp live",
    accountId,
    requiredPluginIds: ["whatsapp"],
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
      logicalConversationKind = input.conversation.kind === "direct" ? "direct" : "group";
      const targets = resolveWhatsAppQaMessageTargets({
        driverPhoneE164: runtimeEnv.driverPhoneE164,
        groupJid: runtimeEnv.groupJid,
        scenarioTarget: logicalConversationKind === "direct" ? "dm" : "group",
        sutPhoneE164: runtimeEnv.sutPhoneE164,
      });
      const quotedMessageId = input.replyToId ? nativeMessageIds.get(input.replyToId) : undefined;
      const sent = await getDriver().sendText(
        targets.driverTarget,
        input.text,
        quotedMessageId
          ? {
              quotedMessageKey: {
                id: quotedMessageId,
                remoteJid: targets.driverTarget,
                fromMe: true,
              },
            }
          : undefined,
      );
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: runtimeEnv.driverPhoneE164,
      });
      if (sent.messageId) {
        nativeMessageIds.set(message.id, sent.messageId);
        busMessageIds.set(sent.messageId, message.id);
      }
      return message;
    },
    resetTransport: () => {
      logicalConversationId = dmTargets.gatewayTarget;
      logicalConversationKind = "direct";
      nativeMessageIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      buildWhatsAppQaConfig({} as OpenClawConfig, {
        allowFrom: [runtimeEnv.driverPhoneE164],
        authDir: sutAuthDir,
        dmPolicy: "allowlist",
        groupJid: runtimeEnv.groupJid,
        overrides: options.transportPolicy?.topLevelReplies ? { replyToMode: "off" } : undefined,
        sutAccountId: accountId,
      }),
    prepareFlow: createWhatsAppQaScenarioEnvironment({
      accountId,
      driverAuthDir,
      explicitScenarioSelection: options.explicitScenarioSelection === true,
      getDriver,
      replaceDriver: async (nextDriver) => {
        driver = nextDriver;
        observedCount = driver.getObservedMessages().length;
      },
      runtimeEnv,
      sutAuthDir,
    }).prepareFlow,
    waitReady: async ({ gateway }) =>
      await waitForWhatsAppChannelStable(gateway as never, accountId),
    buildAgentDelivery: () => ({
      channel: "whatsapp",
      to: dmTargets.gatewayTarget,
      replyChannel: "whatsapp",
      replyTo: dmTargets.gatewayTarget,
    }),
    async handleAction() {
      throw new Error("WhatsApp live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Uses the WhatsApp live adapter."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      // Credential and auth cleanup must run even when the live driver cannot close cleanly.
      try {
        await getDriver().close();
      } finally {
        try {
          await heartbeat.stop();
        } finally {
          try {
            await lease.release();
          } finally {
            await fs.rm(authRoot, { force: true, recursive: true });
          }
        }
      }
    },
  };
}
