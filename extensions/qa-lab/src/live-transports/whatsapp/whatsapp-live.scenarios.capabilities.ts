// QA Lab WhatsApp Gateway capability and structured-message scenarios.
import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WhatsAppQaScenarioDefinition } from "./whatsapp-live.contracts.js";
import {
  WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
  WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_MARKER,
  WHATSAPP_QA_ONE_PIXEL_PNG,
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  callWhatsAppGatewaySendConcurrently,
  createWhatsAppQaAudioOggOpusBuffer,
  createWhatsAppQaPdfBuffer,
  requireWhatsAppTriggerMessageId,
  runWhatsAppStructuredInboundChecks,
  waitForScenarioObservedMessage,
  waitForWhatsAppScenarioSutMessage,
  waitForWhatsAppSutReactionToTrigger,
  writeWhatsAppQaWorkspaceFixture,
} from "./whatsapp-live.operations.js";

export const WHATSAPP_QA_CAPABILITY_SCENARIOS: WhatsAppQaScenarioDefinition[] = [
  {
    id: "whatsapp-outbound-document-preserves-filename",
    title: "WhatsApp direct Gateway document preserves filename and caption",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_DOCUMENT_FILE_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const documentPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaPdfBuffer(),
            fileName: `whatsapp-qa-report-${token}.pdf`,
          });
          const documentStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            forceDocument: true,
            label: "document-filename",
            mediaUrl: documentPath,
            message: `${token}_CAPTION`,
          });
          const document = await waitForScenarioObservedMessage(context, {
            observedAfter: documentStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.text.includes(`${token}_CAPTION`) &&
              message.mediaFileName === `whatsapp-qa-report-${token}.pdf`,
          });
          return `document ${document.mediaFileName ?? "<missing filename>"} preserved`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before document filename check: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-outbound-send-serialization",
    title: "WhatsApp parallel Gateway sends deliver every outbound message",
    defaultEnabled: false,
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_SERIAL_SEND_${randomUUID().slice(0, 8).toUpperCase()}`;
      const markers = Array.from({ length: 5 }, (_, index) => `${token}_${index + 1}`);
      return {
        afterReply: async (_reply, context) => {
          const sendsStartedAt = new Date();
          await callWhatsAppGatewaySendConcurrently(
            context,
            markers.map((marker, index) => ({
              label: `parallel-${index + 1}`,
              message: marker,
            })),
          );
          await Promise.all(
            markers.map((marker) =>
              waitForScenarioObservedMessage(context, {
                observedAfter: sendsStartedAt,
                match: (message) => message.kind === "text" && message.text.includes(marker),
              }),
            ),
          );
          return `gateway parallel send delivered ${markers.length}/${markers.length} messages`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before parallel send checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-outbound-poll",
    title: "WhatsApp direct Gateway poll delivers outbound native poll",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_OUTBOUND_POLL_${randomUUID().slice(0, 8).toUpperCase()}`;
      const question = `${token} choose one`;
      return {
        afterReply: async (_reply, context) => {
          const pollStartedAt = new Date();
          await callWhatsAppGatewayPoll(context, {
            label: "poll",
            options: ["alpha", "beta"],
            question,
          });
          const poll = await waitForScenarioObservedMessage(context, {
            observedAfter: pollStartedAt,
            match: (message) =>
              message.kind === "poll" &&
              message.poll?.question === question &&
              message.poll.options.includes("alpha") &&
              message.poll.options.includes("beta"),
          });
          return `poll observed with ${poll.poll?.options.length ?? 0} options`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before outbound poll check: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-outbound-media",
    title: "WhatsApp direct Gateway send delivers media to a group",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_OUTBOUND_MEDIA_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const mediaRootToken = randomUUID().slice(0, 8);
          const imagePath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: WHATSAPP_QA_ONE_PIXEL_PNG,
            fileName: `whatsapp-qa-group-${mediaRootToken}.png`,
          });
          const documentPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaPdfBuffer(),
            fileName: `whatsapp-qa-group-${mediaRootToken}.pdf`,
          });

          const imageStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            label: "group-image",
            mediaUrl: imagePath,
            message: `${token}_IMAGE`,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: imageStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(`${token}_IMAGE`),
          });

          const documentStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            forceDocument: true,
            label: "group-document",
            mediaUrl: documentPath,
            message: `${token}_DOCUMENT`,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: documentStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              (message.mediaType === "application/pdf" ||
                message.mediaFileName?.endsWith(".pdf") === true) &&
              message.text.includes(`${token}_DOCUMENT`),
          });
          return "gateway send delivered image and document media to the group";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker before group outbound media checks: ${token}`,
        matchText: token,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-outbound-audio",
    title: "WhatsApp direct Gateway send delivers audio to a group",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_OUTBOUND_AUDIO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const audioPath = await writeWhatsAppQaWorkspaceFixture(context, {
            buffer: createWhatsAppQaAudioOggOpusBuffer({ variant: "group-trigger" }),
            fileName: `whatsapp-qa-group-audio-${token}.ogg`,
          });
          const audioStartedAt = new Date();
          await callWhatsAppGatewaySend(context, {
            asVoice: true,
            label: "group-audio",
            mediaUrl: audioPath,
            message: `${token}_AUDIO`,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: audioStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "media" &&
              message.hasMedia === true &&
              message.mediaType?.startsWith("audio/") === true,
          });
          await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: audioStartedAt,
            targetKind: "group",
            match: (message) => message.text.includes(`${token}_AUDIO`),
          });
          return "gateway send delivered audio media to the group";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker before group outbound audio check: ${token}`,
        matchText: token,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-group-outbound-poll",
    title: "WhatsApp direct Gateway poll delivers native poll to a group",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 90_000,
    requiresGroupJid: true,
    buildRun: () => {
      const token = `WHATSAPP_QA_GROUP_OUTBOUND_POLL_${randomUUID().slice(0, 8).toUpperCase()}`;
      const question = `${token} choose one`;
      return {
        afterReply: async (_reply, context) => {
          const pollStartedAt = new Date();
          await callWhatsAppGatewayPoll(context, {
            label: "group-poll",
            options: ["alpha", "beta"],
            question,
          });
          const poll = await waitForWhatsAppScenarioSutMessage(context, {
            observedAfter: pollStartedAt,
            targetKind: "group",
            match: (message) =>
              message.kind === "poll" &&
              message.poll?.question === question &&
              message.poll.options.includes("alpha") &&
              message.poll.options.includes("beta"),
          });
          return `group poll observed with ${poll.poll?.options.length ?? 0} options`;
        },
        configMode: "allowlist",
        expectReply: true,
        input: `openclawqa reply with only this exact marker before group outbound poll check: ${token}`,
        matchText: token,
        target: "group",
      };
    },
  },
  {
    id: "whatsapp-message-actions",
    title: "WhatsApp direct Gateway message.action react and upload-file execute",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    configOverrides: {
      actions: true,
    },
    buildRun: () => {
      const token = `WHATSAPP_QA_ACTIONS_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        afterReply: async (_reply, context) => {
          const triggerMessageId = requireWhatsAppTriggerMessageId(context);
          const reactionStartedAt = new Date();
          await callWhatsAppGatewayMessageAction(context, {
            action: "react",
            label: "react",
            params: {
              emoji: "👍",
              messageId: triggerMessageId,
            },
          });
          await waitForWhatsAppSutReactionToTrigger(context, {
            expectation: { emoji: "👍" },
            observedAfter: reactionStartedAt,
          });

          const uploadStartedAt = new Date();
          await callWhatsAppGatewayMessageAction(context, {
            action: "upload-file",
            label: "upload-file",
            params: {
              buffer: WHATSAPP_QA_ONE_PIXEL_PNG.toString("base64"),
              caption: `${token}_UPLOAD`,
              contentType: "image/png",
              filename: "whatsapp-qa-upload.png",
            },
          });
          await waitForScenarioObservedMessage(context, {
            observedAfter: uploadStartedAt,
            match: (message) =>
              message.kind === "media" &&
              message.mediaType?.startsWith("image/") === true &&
              message.text.includes(`${token}_UPLOAD`),
          });
          return "message.action react and upload-file observed";
        },
        configMode: "allowlist",
        expectReply: true,
        input: `Reply with only this exact marker before action checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-inbound-structured-messages",
    title: "WhatsApp inbound structured messages reach the agent",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 240_000,
    buildRun: () => {
      const token = `WHATSAPP_QA_STRUCTURED_${randomUUID().slice(0, 8).toUpperCase()}`;
      const locationToken = `${token}_LOCATION`;
      const contactToken = `${token}_CONTACT`;
      const stickerToken = `${token}_STICKER`;
      const locationCoordinateText = "37.774900, -122.419400";
      return {
        afterReply: async (_reply, context) => {
          const waitForStructuredReply = async (
            label: string,
            observedAfter: Date,
            expectedToken: string,
          ) => {
            try {
              return await waitForScenarioObservedMessage(context, {
                observedAfter,
                timeoutMs: 60_000,
                match: (message) => message.text.includes(expectedToken),
                diagnosticChecks: [
                  {
                    label: "containsExpectedToken",
                    match: (message) => message.text.includes(expectedToken),
                  },
                ],
              });
            } catch (error) {
              throw new Error(
                `timed out waiting for WhatsApp structured ${label} reply (${expectedToken}): ${formatErrorMessage(error)}`,
                { cause: error },
              );
            }
          };

          await runWhatsAppStructuredInboundChecks({
            contactToken,
            documentToken: `${token}_DOCUMENT`,
            driver: context.driver,
            driverPhoneE164: context.driverPhoneE164,
            locationToken,
            stickerToken,
            target: context.target,
            waitForStructuredReply,
          });
          return "document, location, contact, and sticker elicited replies";
        },
        configMode: "allowlist",
        expectReply: true,
        input:
          `When a later WhatsApp location message shows ${locationCoordinateText}, ` +
          `reply with only this WhatsApp location marker: ${locationToken}. ` +
          `When a later WhatsApp contact message appears, ` +
          `reply with only this WhatsApp contact marker: ${contactToken}. ` +
          `When a later WhatsApp sticker message appears, ` +
          `reply with only this WhatsApp sticker marker: ${stickerToken}. ` +
          `Reply with only this exact marker before structured inbound checks: ${token}`,
        matchText: token,
        target: "dm",
      };
    },
  },
  {
    id: "whatsapp-group-audio-gating",
    title: "WhatsApp group audio mention gating",
    defaultProviderModes: ["mock-openai"],
    timeoutMs: 120_000,
    configOverrides: {
      audioPreflight: true,
    },
    requiredPluginIds: ["openai"],
    requiresGroupJid: true,
    buildRun: () => ({
      configMode: "allowlist",
      expectReply: true,
      input: "",
      matchText: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_MARKER,
      quietInput: "",
      quietSendMode: {
        fileName: "whatsapp-qa-group-audio-quiet.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer(),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      quietWindowMs: 5_000,
      sendMode: {
        fileName: "whatsapp-qa-group-audio.ogg",
        kind: "media",
        mediaBuffer: createWhatsAppQaAudioOggOpusBuffer({
          variant: "group-trigger",
        }),
        mediaType: WHATSAPP_QA_AUDIO_OGG_OPUS_MIME,
      },
      target: "group",
    }),
  },
];
