// QA Lab WhatsApp user-path action and inbound media scenarios.
import { randomUUID } from "node:crypto";
import type { WhatsAppQaScenarioDefinition } from "./whatsapp-live.contracts.js";
import {
  WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
  WHATSAPP_QA_AUDIO_TRANSCRIPT_MARKER,
  WHATSAPP_QA_ONE_PIXEL_PNG,
  assertWhatsAppMessageFromSutPhone,
  callWhatsAppGatewaySend,
  createWhatsAppQaAudioOggOpusBuffer,
  createWhatsAppQaAudioWavBuffer,
  createWhatsAppQaPdfBuffer,
  matchesWhatsAppSutReactionToTrigger,
  waitForNoWhatsAppReply,
  waitForScenarioObservedMessage,
  waitForWhatsAppScenarioSutMessage,
  waitForWhatsAppSutReactionToTrigger,
  writeWhatsAppQaWorkspaceFixture,
} from "./whatsapp-live.operations.js";

export const WHATSAPP_QA_USER_PATH_SCENARIOS: WhatsAppQaScenarioDefinition[] = [
  {
    id: "whatsapp-agent-message-action-react",
    title: "WhatsApp user-path agent reaction uses the message tool",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_AGENT_REACT_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { emoji: "👍" },
            timeoutMs: 60_000,
          });
          return `agent message reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message, context) =>
          matchesWhatsAppSutReactionToTrigger(message, context, { emoji: "👍" }),
        configMode: "allowlist",
        expectReply: false,
        input:
          `React to this WhatsApp message with thumbs up for QA action check ${token}. ` +
          "Do not send any visible text reply after the reaction.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-agent-message-action-upload-file",
    title: "WhatsApp user-path agent upload-file sends media",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_AGENT_UPLOAD_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const media = await waitForScenarioObservedMessage(context, {
            observedAfter: context.requestStartedAt,
            timeoutMs: 60_000,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(token),
          });
          return `agent upload-file media ${media.mediaType ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message) =>
          message.kind === "media" &&
          message.mediaType?.startsWith("image/") === true &&
          message.text.includes(token),
        configMode: "allowlist",
        expectReply: false,
        input:
          `Use the WhatsApp message tool upload-file action to send a PNG with caption ${token}. ` +
          "Do not send any visible text reply after the upload.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-agent-message-action-react",
    title: "WhatsApp group user-path agent reaction uses the message tool",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_AGENT_REACT_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const reaction = await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { emoji: "👍" },
            timeoutMs: 60_000,
          });
          return `group agent message reaction ${reaction.reaction?.emoji ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message, context) =>
          matchesWhatsAppSutReactionToTrigger(message, context, { emoji: "👍" }),
        configMode: "allowlist",
        expectReply: false,
        input:
          `openclawqa react to this WhatsApp group message with thumbs up for QA action check ${token}. ` +
          "Do not send any visible text reply after the reaction.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-agent-message-action-upload-file",
    title: "WhatsApp group user-path agent upload-file sends media",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      actions: true,
    },
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_AGENT_UPLOAD_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterSend: async (context) => {
          const media = await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: context.requestStartedAt,
            targetKind: "group",
            timeoutMs: 60_000,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(token),
          });
          return `group agent upload-file media ${media.mediaType ?? "<unknown>"} observed`;
        },
        allowQuietWindowMessage: (message) =>
          message.kind === "media" &&
          message.mediaType?.startsWith("image/") === true &&
          message.text.includes(token),
        configMode: "allowlist",
        expectReply: false,
        input:
          `openclawqa use the WhatsApp message tool upload-file action to send a PNG with caption ${token}. ` +
          "Do not send any visible text reply after the upload.",
        matchText: token,
        quietWindowMs: 8_000,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-inbound-reaction-no-trigger",
    title: "WhatsApp inbound user reaction does not start a fresh run",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_INBOUND_REACTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (reply, context) => {
          assertWhatsAppMessageFromSutPhone(reply, context);
          if (!reply.messageId) {
            throw new Error("WhatsApp SUT reply did not include a message id to react to.");
          }
          const reactionStartedAt = new Date();
          await context.driver.sendReaction(context.target, reply.messageId, "❤️", {
            fromMe: false,
          });
          await waitForNoWhatsAppReply({
            driver: context.driver,
            observedAfter: reactionStartedAt,
            sutPhoneE164: context.sutPhoneE164,
            target: "dm",
            windowMs: 5_000,
          });
          return "driver reaction to SUT message did not trigger a fresh reply";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before inbound reaction check: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-reply-context-isolation",
    title: "WhatsApp direct Gateway send does not reuse prior quote context",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_REPLY_ISOLATION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          if (!context.sent.messageId) {
            throw new Error("WhatsApp driver did not return a triggering message id.");
          }
          const quotedStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "quoted",
            message: `${token}_QUOTED`,
            replyToId: context.sent.messageId,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: quotedStartedAt,
            diagnosticChecks: [
              {
                label: "textMarker",
                match: (message) => message.text.includes(`${token}_QUOTED`),
              },
              {
                label: "quotedMessageIdMatchesTrigger",
                match: (message) => message.quoted?.messageId === context.sent.messageId,
              },
            ],
            match: (message) =>
              message.text.includes(`${token}_QUOTED`) &&
              message.quoted?.messageId === context.sent.messageId,
          });

          const freshStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "fresh",
            message: `${token}_FRESH`,
          });
          const fresh = await waitForScenarioObservedMessage(context, {
            observedAfter: freshStartedAt,
            match: (message) => message.text.includes(`${token}_FRESH`),
          });
          if (fresh.quoted?.messageId) {
            throw new Error(
              `expected fresh WhatsApp send without quote metadata, got quoted message ${fresh.quoted.messageId}`,
            );
          }
          return "quoted send and fresh send used independent reply context";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before reply isolation checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-inbound-image-caption",
    title: "WhatsApp inbound image caption reaches the agent",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 60_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_IMAGE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        input: `This image caption asks you to reply with only this exact marker: ${token}`,
        matchText: token,
        sendMode: {
          fileName: "whatsapp-qa.png",
          kind: "media",
          mediaBuffer: WHATSAPP_QA_ONE_PIXEL_PNG,
          mediaType: "image/png",
        },
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-audio-preflight",
    title: "WhatsApp inbound audio preflight transcript reaches the agent",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    configOverrides: {
      audioPreflight: true,
    },
    requiredPluginIds: ["openai"],
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      input: "",
      matchText: WHATSAPP_QA_AUDIO_TRANSCRIPT_MARKER,
      sendMode: {
        fileName: "whatsapp-qa-audio.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer(),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      target: "dm",
    }),
  },
  {
    id: "whatsapp-outbound-media-matrix",
    title: "WhatsApp direct Gateway send delivers outbound media variants",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_OUTBOUND_MEDIA_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const mediaRootToken = randomUUID().slice(0, 8);
          const imagePath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: WHATSAPP_QA_ONE_PIXEL_PNG,
            fileName: `whatsapp-qa-${mediaRootToken}.png`,
          });
          const documentPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaPdfBuffer(),
            fileName: `whatsapp-qa-${mediaRootToken}.pdf`,
          });
          const audioPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaAudioWavBuffer(),
            fileName: `whatsapp-qa-${mediaRootToken}.wav`,
          });

          const imageStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "image",
            mediaUrl: imagePath,
            message: `${token}_IMAGE`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: imageStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(`${token}_IMAGE`),
          });

          const documentStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            forceDocument: true,
            label: "document",
            mediaUrl: documentPath,
            message: `${token}_DOCUMENT`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: documentStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              (message.mediaType === "application/pdf" ||
                message.mediaFileName?.endsWith(".pdf") === true) &&
              message.text.includes(`${token}_DOCUMENT`),
          });

          const audioStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            asVoice: true,
            label: "audio",
            mediaUrl: audioPath,
            message: `${token}_AUDIO`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: audioStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("audio/") === true,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: audioStartedAt,
            match: (message) => message.text.includes(`${token}_AUDIO`),
          });

          const multiStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "multi",
            mediaUrls: [imagePath, documentPath],
            message: `${token}_MULTI`,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: multiStartedAt,
            match: (message) =>
              message.kind === "media" && message.mediaType?.startsWith("image/") === true,
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: multiStartedAt,
            match: (message) =>
              message.kind === "media" &&
              (message.mediaType === "application/pdf" ||
                message.mediaFileName?.endsWith(".pdf") === true),
          });
          return "gateway send delivered image, document, audio, and multi-media";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before outbound media checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
];
