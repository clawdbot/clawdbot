// QA Lab WhatsApp delivery-shape, status, and approval scenarios.
import { randomUUID } from "node:crypto";
import type { WhatsAppQaScenarioDefinition } from "./whatsapp-live.contracts.js";
import {
  callWhatsAppGatewaySend,
  waitForScenarioObservedMessage,
  waitForWhatsAppSutReactionSequenceToTrigger,
  waitForWhatsAppSutReactionToTrigger,
} from "./whatsapp-live.operations.js";

export const WHATSAPP_QA_DELIVERY_SCENARIOS: WhatsAppQaScenarioDefinition[] = [
  {
    id: "whatsapp-reply-delivery-shape",
    title: "WhatsApp direct Gateway send chunks long replies",
    timeoutMs: 120_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_REPLY_SHAPE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          if (!context.sent.messageId) {
            throw new Error("WhatsApp driver did not return a triggering message id.");
          }
          const quotedTriggerMessageId = context.sent.messageId;
          const chunkStartedAt = new Date();
          const longText = `${token}_LONG_BEGIN\n${"A".repeat(4_500)}\n${token}_LONG_END`;
          await callWhatsAppGatewaySend(context, {
            label: "long-reply",
            message: longText,
            replyToId: quotedTriggerMessageId,
          });
          const firstChunk = await waitForScenarioObservedMessage(context, {
            observedAfter: chunkStartedAt,
            diagnosticChecks: [
              {
                label: "longBeginMarker",
                match: (message) => message.text.includes(`${token}_LONG_BEGIN`),
              },
              {
                label: "quotesTrigger",
                match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
              },
            ],
            match: (message) =>
              message.text.includes(`${token}_LONG_BEGIN`) &&
              message.quoted?.messageId === quotedTriggerMessageId,
          });
          const secondChunk = await waitForScenarioObservedMessage(context, {
            observedAfter: chunkStartedAt,
            diagnosticChecks: [
              {
                label: "longEndMarker",
                match: (message) => message.text.includes(`${token}_LONG_END`),
              },
              {
                label: "quotesTrigger",
                match: (message) => message.quoted?.messageId === quotedTriggerMessageId,
              },
            ],
            match: (message) =>
              message.messageId !== firstChunk.messageId &&
              message.text.includes(`${token}_LONG_END`) &&
              message.quoted?.messageId === quotedTriggerMessageId,
          });
          return `long reply chunked across ${firstChunk.messageId ?? "<first>"} and ${secondChunk.messageId ?? "<second>"}`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before reply-shape checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-stream-final-message-accounting",
    title: "WhatsApp streamed final response has exactly the final chunks",
    timeoutMs: 90_000,
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      expectedJoinedSutTextIncludes: ["WHATSAPP-LONG-FINAL-BEGIN", "WHATSAPP-LONG-FINAL-END"],
      expectedSutMessageCount: 2,
      input: "WhatsApp long final QA check. Use the scripted long final response.",
      matchText: "WHATSAPP-LONG-FINAL-BEGIN",
      settleMs: 4_000,
      target: "dm",
    }),
  },
  {
    id: "whatsapp-approval-exec-deny-native",
    title: "WhatsApp native exec approval prompt denies",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    buildRun: () => ({
      approvalKind: "exec",
      decision: "deny",
      kind: "approval",
      token: `WHATSAPP_QA_EXEC_DENY_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-status-reactions",
    title: "WhatsApp status reactions are observable",
    timeoutMs: 60_000,
    configOverrides: {
      statusReactions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_STATUS_REACTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { anyEmoji: true },
            timeoutMs: 30_000,
          });
          return `status reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker after normal processing: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-status-reaction-lifecycle",
    title: "WhatsApp status reaction lifecycle updates the triggering message",
    timeoutMs: 90_000,
    configOverrides: {
      statusReactions: {
        timing: {
          debounceMs: 0,
          stallSoftMs: 60_000,
          stallHardMs: 120_000,
        },
      },
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_STATUS_LIFECYCLE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const reactions = await waitForWhatsAppSutReactionSequenceToTrigger(context, {
            emojis: ["👀", "✅"],
            observedAfter: context.requestStartedAt,
            timeoutMs: 60_000,
          });
          for (const reaction of reactions) {
            context.recordObservedMessage(reaction);
          }
          return `status reaction lifecycle observed ${reactions
            .map((reaction) => reaction.reaction?.emoji ?? "<unknown>")
            .join(" -> ")}`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker after normal processing: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-allowlist-block",
    title: "WhatsApp group outside allowlist stays quiet",
    timeoutMs: 8_000,
    configOverrides: {
      blockGroupSender: true,
      groupPolicy: "allowlist",
    },
    requiresGroupJid: true,
    buildRun: () => {
      const quietToken = `WHATSAPP_QA_GROUP_BLOCK_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: false,
        input: `openclawqa blocked group should not reply with ${quietToken}`,
        matchText: quietToken,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-approval-exec-native",
    title: "WhatsApp native exec approval prompt resolves",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    buildRun: () => ({
      approvalKind: "exec",
      decision: "allow-once",
      kind: "approval",
      token: `WHATSAPP_QA_EXEC_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-approval-exec-reaction-native",
    title: "WhatsApp native exec approval resolves from reaction",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    buildRun: () => ({
      approvalKind: "exec",
      decision: "allow-once",
      decisionMode: "reaction",
      kind: "approval",
      token: `WHATSAPP_QA_EXEC_REACTION_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-approval-exec-group-reaction-native",
    title: "WhatsApp group-origin exec approval resolves from reaction",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
      },
    },
    requiresGroupJid: true,
    buildRun: () => ({
      approvalKind: "exec",
      decision: "allow-once",
      decisionMode: "reaction",
      kind: "approval",
      target: "group",
      token: `WHATSAPP_QA_GROUP_EXEC_REACTION_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "whatsapp-approval-plugin-native",
    title: "WhatsApp native plugin approval prompt resolves with exec approvals enabled",
    timeoutMs: 60_000,
    configOverrides: {
      approvals: {
        exec: true,
        plugin: true,
      },
    },
    buildRun: () => ({
      approvalKind: "plugin",
      decision: "allow-once",
      kind: "approval",
      token: `WHATSAPP_QA_PLUGIN_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
];
