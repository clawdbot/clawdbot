// QA Lab WhatsApp conversation and reply-context scenarios.
import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  toWhatsAppQaError,
  type WhatsAppQaMessageScenarioRun,
  type WhatsAppQaScenarioDefinition,
} from "./whatsapp-live.contracts.js";
import {
  assertWhatsAppMessageFromSutPhone,
  assertWhatsAppMessagesFromSutPhone,
  buildWhatsAppQuotedMessageKeyFromObservedMessage,
  resolveWhatsAppQaNoReplyTarget,
  waitForDistinctWhatsAppSutMessages,
  waitForNoWhatsAppReply,
  waitForWhatsAppScenarioSutMessage,
} from "./whatsapp-live.operations.js";

function buildWhatsAppQuoteReplyRun(target: "dm" | "group"): WhatsAppQaMessageScenarioRun {
  const token = `WHATSAPP_QA_REPLY_TO_${target.toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
  const input =
    target === "group"
      ? `openclawqa reply with only this exact marker: ${token}`
      : `Reply with only this exact marker: ${token}`;
  return {
    configMode: "allowlist",
    expectReply: true,
    input,
    matchText: token,
    target,
    verify: (reply, context) => {
      if (!context.sent.messageId) {
        throw new Error("WhatsApp driver did not return a triggering message id.");
      }
      if (reply.quoted?.messageId !== context.sent.messageId) {
        throw new Error(
          `expected reply quote ${context.sent.messageId}, got ${reply.quoted?.messageId ?? "<missing>"}`,
        );
      }
    },
  };
}

export const WHATSAPP_QA_CONVERSATION_SCENARIOS: WhatsAppQaScenarioDefinition[] = [
  {
    id: "whatsapp-canary",
    title: "WhatsApp DM canary",
    timeoutMs: 60_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-mention-gating",
    title: "WhatsApp group mention gating",
    timeoutMs: 60_000,
    requiresGroupJid: true,
    buildRun: () => {
      const quietToken = `WHATSAPP_QA_GROUP_QUIET_${randomUUID().slice(0, 8).toUpperCase()}`;
      const replyToken = `WHATSAPP_QA_GROUP_MENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker: ${replyToken}`,
        matchText: replyToken,
        quietInput: `This group message is intentionally unmentioned. If you respond, include ${quietToken}.`,
        quietMatchText: quietToken,
        quietWindowMs: 5_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-pending-history-context",
    title: "WhatsApp group pending history reaches mentioned turns",
    timeoutMs: 90_000,
    configOverrides: {
      groupHistoryLimit: 50,
      groupPolicy: "open",
      inboundDebounceMs: 0,
      replyToMode: "all",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const quietMarker = `WHATSAPP_QA_PENDING_HISTORY_QUIET_${suffix}`;
      const contextSentinel = `WHATSAPP_QA_PENDING_HISTORY_CONTEXT_ONLY_${suffix}`;
      const triggerMarker = `WHATSAPP_QA_PENDING_HISTORY_TRIGGER_${suffix}`;
      const okMarker = `WHATSAPP_QA_PENDING_HISTORY_OK_${suffix}`;
      return {
        configMode: "open",
        expectReply: true,
        expectedSutMessageCount: 1,
        input:
          `openclawqa pending history context check ${triggerMarker}. ` +
          `Reply with only ${okMarker} only if the previous quiet group message is present ` +
          `in prior group context with its context-only sentinel. ` +
          "Do not use current-message text as proof.",
        matchText: okMarker,
        quietInput: `quiet context marker ${quietMarker} ${contextSentinel}`,
        quietWindowMs: 5_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-broadcast-group-fanout",
    title: "WhatsApp group broadcast fans out to multiple agents",
    timeoutMs: 120_000,
    configOverrides: {
      broadcast: {
        agents: ["main", "qa-second"],
        strategy: "sequential",
      },
      groupPolicy: "open",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_BROADCAST_TOKEN_${randomUUID().slice(0, 8).toUpperCase()}`;
      const mainMarker = `${token}_MAIN`;
      const secondMarker = `${token}_SECOND`;
      return {
        afterReply: async (reply, context) => {
          const replies = await waitForDistinctWhatsAppSutMessages(context, {
            initialMessages: [reply],
            matchers: [
              (message) => message.text.includes(mainMarker),
              (message) => message.text.includes(secondMarker),
            ],
            observedAfter: context.requestStartedAt,
            timeoutMs: 60_000,
          });
          assertWhatsAppMessagesFromSutPhone(replies, context);
          return "broadcast fanout produced main and qa-second replies";
        },
        configMode: "open",
        expectReply: true,
        input: `openclawqa broadcast fanout check ${token}`,
        matchText: mainMarker,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-activation-always",
    title: "WhatsApp group activation always wakes unmentioned messages",
    timeoutMs: 120_000,
    configOverrides: {
      groupPolicy: "open",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const alwaysMarker = `WHATSAPP_QA_ACTIVATION_ALWAYS_${suffix}`;
      const quietMarker = `WHATSAPP_QA_ACTIVATION_QUIET_${suffix}`;
      return {
        afterReply: async (reply, context) => {
          assertWhatsAppMessageFromSutPhone(reply, context);
          let activationProbeError: unknown;
          try {
            const alwaysStartedAt = new Date();
            await context.driver.sendText(
              context.target,
              `Group activation visible behavior marker ${alwaysMarker}`,
            );
            const alwaysReply = await waitForWhatsAppScenarioSutMessage(context, {
              match: (message) => message.text.includes(alwaysMarker),
              observedAfter: alwaysStartedAt,
              targetKind: "group",
              timeoutMs: 60_000,
            });
            assertWhatsAppMessageFromSutPhone(alwaysReply, context);
          } catch (error) {
            activationProbeError = error;
          }

          let restoreError: unknown;
          const restoreStartedAt = new Date();
          try {
            await context.driver.sendText(context.target, "/activation mention");
            const restoreReply = await waitForWhatsAppScenarioSutMessage(context, {
              match: (message) => /\bactivation\b.*\bmention\b/iu.test(message.text),
              observedAfter: restoreStartedAt,
              targetKind: "group",
              timeoutMs: 60_000,
            });
            assertWhatsAppMessageFromSutPhone(restoreReply, context);
          } catch (error) {
            restoreError = error;
          }

          if (activationProbeError && restoreError) {
            throw new Error(
              `activation always probe failed; additionally failed to restore mention mode: ${formatErrorMessage(restoreError)}`,
              { cause: activationProbeError },
            );
          }
          if (activationProbeError) {
            throw toWhatsAppQaError(activationProbeError);
          }
          if (restoreError) {
            throw toWhatsAppQaError(restoreError);
          }

          const quietStartedAt = new Date();
          await context.driver.sendText(
            context.target,
            `Group activation quiet marker ${quietMarker}`,
          );
          await waitForNoWhatsAppReply({
            driver: context.driver,
            observedAfter: quietStartedAt,
            sutPhoneE164: context.sutPhoneE164,
            windowMs: 5_000,
            ...resolveWhatsAppQaNoReplyTarget({
              groupJid: context.target,
              target: "group",
            }),
          });
          return "activation always replied to an unmentioned group message and mention mode was restored";
        },
        configMode: "allowlist",
        expectReply: true,
        input: "/activation always",
        matchText: /\bactivation\b.*\balways\b/iu,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-reply-to-bot-triggers",
    title: "WhatsApp group reply to bot wakes without an explicit mention",
    timeoutMs: 120_000,
    configOverrides: {
      groupPolicy: "open",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const seedMarker = `WHATSAPP_QA_REPLY_TO_BOT_SEED_${suffix}`;
      const triggerMarker = `WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_${suffix}`;
      return {
        afterReply: async (reply, context) => {
          assertWhatsAppMessageFromSutPhone(reply, context);
          const quotedStartedAt = new Date();
          const quotedTrigger = await context.driver.sendText(
            context.target,
            `Quoted implicit reply trigger marker ${triggerMarker}`,
            {
              quotedMessageKey: buildWhatsAppQuotedMessageKeyFromObservedMessage(reply, {
                remoteJid: context.target,
              }),
            },
          );
          if (!quotedTrigger.messageId) {
            throw new Error("WhatsApp driver did not return a quoted trigger message id.");
          }
          const quotedTriggerMessageId = quotedTrigger.messageId;
          const quotedReply = await waitForWhatsAppScenarioSutMessage(context, {
            diagnosticChecks: [
              {
                label: "containsTriggerMarker",
                match: (message) => message.text.includes(triggerMarker),
              },
              {
                label: "quotesTrigger",
                match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
              },
            ],
            match: (message) =>
              message.text.includes(triggerMarker) &&
              message.quoted?.messageId === quotedTriggerMessageId,
            observedAfter: quotedStartedAt,
            targetKind: "group",
            timeoutMs: 60_000,
          });
          assertWhatsAppMessageFromSutPhone(quotedReply, context);
          return "quoted reply to bot triggered a group response without an explicit mention";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa Mentioned group seed marker ${seedMarker}`,
        matchText: seedMarker,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-top-level-reply-shape",
    title: "WhatsApp DM top-level reply shape",
    timeoutMs: 60_000,
    configOverrides: {
      replyToMode: "off",
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_TOP_LEVEL_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker: ${token}`,
        matchText: token,
        target: "dm",
        verify: (reply) => {
          if (reply.quoted?.messageId) {
            throw new Error(
              `expected top-level WhatsApp reply without quote metadata, got quoted message ${reply.quoted.messageId}`,
            );
          }
        },
      };
    },
  },
  {
    id: "whatsapp-reply-to-message",
    title: "WhatsApp DM reply-to mode quotes the triggering message",
    timeoutMs: 60_000,
    configOverrides: {
      replyToMode: "all",
    },
    buildRun: () => buildWhatsAppQuoteReplyRun("dm"),
  },
  {
    id: "whatsapp-group-reply-to-message",
    title: "WhatsApp group reply-to mode quotes the triggering message",
    timeoutMs: 60_000,
    configOverrides: {
      replyToMode: "all",
    },
    requiresGroupJid: true,
    buildRun: () => buildWhatsAppQuoteReplyRun("group"),
  },
  {
    id: "whatsapp-reply-to-mode-batched",
    title: "WhatsApp batched reply-to mode quotes the queued message",
    timeoutMs: 90_000,
    configOverrides: {
      inboundDebounceMs: 250,
      replyToMode: "batched",
    },
    buildRun: () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const firstToken = `WHATSAPP_QA_BATCHED_FIRST_${suffix}`;
      const finalToken = `WHATSAPP_QA_BATCHED_FINAL_${suffix}`;
      let secondMessageId: string | undefined;
      return {
        afterSend: async (context) => {
          const second = await context.driver.sendText(
            context.target,
            `Second batched WhatsApp QA message. Reply with only this exact marker: ${finalToken} only if the previous queued message is visible in this same run context.`,
          );
          secondMessageId = second.messageId;
          return "second batched message sent before debounce flush";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `First batched WhatsApp QA message ${firstToken}. Wait for the next message before replying.`,
        matchText: finalToken,
        target: "dm",
        verify: (reply) => {
          if (!secondMessageId) {
            throw new Error("WhatsApp driver did not return a second batched message id.");
          }
          if (reply.quoted?.messageId !== secondMessageId) {
            throw new Error(
              `expected batched reply quote ${secondMessageId}, got ${reply.quoted?.messageId ?? "<missing>"}`,
            );
          }
        },
      };
    },
  },
];
