// QA Lab Slack live scenario implementations.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { waitForSlackReaction } from "./slack-live.codex-approval.js";
import {
  SLACK_QA_REACTION_VERIFY_TIMEOUT_MS,
  SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS,
  SLACK_QA_LOG_TAIL_TIMEOUT_MS,
  type SlackQaScenarioImplementation,
  type SlackQaScenarioContext,
} from "./slack-live.contracts.js";
import { waitForSlackScenarioReply } from "./slack-live.message-observations.js";
import {
  isExpectedSlackNativeChartMessage,
  isExpectedSlackNativeTableMessage,
  runSlackTableInvalidBlocksFallbackScenario,
  sendSlackChannelMessage,
  waitForSlackStoredMessage,
} from "./slack-live.observations.js";
import {
  buildSlackChartMessageToolArgs,
  renderSlackChartAccessibleText,
  buildSlackTableMessageToolArgs,
  renderSlackTableAccessibleText,
  buildSlackProgressCommentaryRun,
} from "./slack-live.scenario-fixtures.js";

export const slackQaCanaryScenario: SlackQaScenarioImplementation = {
  buildRun: (sutUserId) => {
    const token = `SLACK_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      expectReply: true,
      input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
      matchText: token,
    };
  },
};

export const slackQaMentionGatingScenario: SlackQaScenarioImplementation = {
  buildRun: () => {
    const token = `SLACK_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      expectReply: false,
      input: `reply with only this exact marker: ${token}`,
      matchText: token,
    };
  },
};

export const slackQaMpimAppMentionDedupeScenario: SlackQaScenarioImplementation = {
  // Keep the event-dedupe assertion independent from Slack's separate
  // streaming preview/final message lifecycle.
  configOverrides: { groupDmEnabled: true, replyToMode: "all", streamingMode: "off" },
  buildRun: (sutUserId) => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const seedMarker = `SLACK_QA_MPIM_SEED_${suffix}`;
    const recallMarker = `SLACK_QA_MPIM_RECALL_${suffix}`;
    const missingMarker = `SLACK_QA_MPIM_MISSING_${suffix}`;
    let openedChannelId: string | undefined;
    const closeOpenedChannel = async (context: Omit<SlackQaScenarioContext, "sentTs">) => {
      if (!openedChannelId) {
        return;
      }
      const channelId = openedChannelId;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await context.sutReadClient.conversations.close({ channel: channelId });
          openedChannelId = undefined;
          return;
        } catch (error) {
          if (attempt === 2) {
            throw error;
          }
          // Retain ownership until Slack confirms closure; one bounded retry
          // covers a transient API failure without hiding a leaked MPIM.
          await sleep(500);
        }
      }
    };
    return {
      expectReply: true,
      input: [
        `<@${sutUserId}> Slack MPIM assistant-history seed check.`,
        `Reply with only a marker in this exact format: ${seedMarker}_BOT_<NONCE>.`,
        "Replace <NONCE> with 8 to 32 new uppercase letters or digits.",
        "Do not include angle brackets, spaces, Markdown, or punctuation.",
      ].join(" "),
      matchText: seedMarker,
      settleObservedMs: 60_000,
      beforeRun: async (context) => {
        const driverAuth = await context.driverClient.auth.test();
        const driverUserId = driverAuth.user_id?.trim();
        if (!driverUserId) {
          throw new Error("Slack QA driver auth.test returned no user_id");
        }
        const members = await context.sutReadClient.conversations.members({
          channel: context.channelId,
          limit: 100,
        });
        const candidateUserIds = (members.members ?? []).filter(
          (userId) => userId !== driverUserId && userId !== context.sutIdentity.userId,
        );
        for (const userId of candidateUserIds) {
          const user = (await context.sutReadClient.users.info({ user: userId })).user;
          if (!user || user.deleted || user.is_bot) {
            continue;
          }
          const opened = await context.sutReadClient.conversations.open({
            return_im: true,
            users: `${driverUserId},${userId}`,
          });
          const channelId = opened.channel?.id?.trim();
          if (!channelId) {
            continue;
          }
          // Track ownership before the metadata call so outer cleanup can still
          // close the MPIM when Slack rejects or times out during inspection.
          openedChannelId = channelId;
          const info = await context.sutReadClient.conversations.info({ channel: channelId });
          if (info.channel?.is_mpim && channelId.startsWith("C")) {
            return { details: "opened C-prefixed MPIM", inputChannelId: channelId };
          }
          await closeOpenedChannel(context);
        }
        throw new Error("Slack QA channel has no human member yielding a C-prefixed MPIM");
      },
      verifyObserved: ({ messages }) => {
        const uniqueReplies = new Map(messages.map((message) => [message.ts, message]));
        const matchingReplies = [...uniqueReplies.values()].filter((message) =>
          message.text.includes(seedMarker),
        );
        if (uniqueReplies.size !== 1 || matchingReplies.length !== 1) {
          throw new Error(
            `expected one MPIM response with the marker, got ${uniqueReplies.size} response(s) and ${matchingReplies.length} marker match(es)`,
          );
        }
        return "one MPIM reply observed after message/app_mention twin delivery";
      },
      afterReply: async (message, context) => {
        if (message.thread_ts !== context.sentTs) {
          throw new Error("MPIM seed reply escaped the native Slack thread");
        }
        const botReplyMarker = message.text?.trim() ?? "";
        const botReplyPrefix = `${seedMarker}_BOT_`;
        const botNonce = botReplyMarker.startsWith(botReplyPrefix)
          ? botReplyMarker.slice(botReplyPrefix.length)
          : "";
        if (!/^[A-Z0-9]{8,32}$/u.test(botNonce)) {
          throw new Error("MPIM seed reply did not contain the provider-generated bot nonce");
        }
        const expectedRecallMarker = `${recallMarker}_${botNonce}`;
        const sent = await sendSlackChannelMessage({
          channelId: context.channelId,
          client: context.driverClient,
          text: [
            `<@${sutUserId}> Slack MPIM assistant-history recall check.`,
            `Recall the nonce from your immediately previous reply beginning with ${botReplyPrefix}.`,
            `Reply with only this exact format: ${recallMarker}_<NONCE>, using that same nonce.`,
            `Otherwise reply with only: ${missingMarker}`,
          ].join(" "),
          threadTs: context.sentTs,
        });
        const reply = await waitForSlackScenarioReply({
          channelId: context.channelId,
          client: context.sutReadClient,
          matchText: expectedRecallMarker,
          observedMessages: [],
          observationScenarioId: "slack-mpim-app-mention-dedupe",
          observationScenarioTitle: "Slack MPIM app mention dispatches once with thread context",
          sentTs: sent.ts,
          sutIdentity: context.sutIdentity,
          threadTs: context.sentTs,
          timeoutMs: 60_000,
        });
        if (reply.message.thread_ts !== context.sentTs) {
          throw new Error("MPIM assistant-history recall reply escaped the native Slack thread");
        }
        if (reply.message.text?.trim() !== expectedRecallMarker) {
          throw new Error("MPIM assistant-history recall reply did not reproduce the hidden nonce");
        }
        return [
          "threadHistoryHeader=true",
          "assistantAttributedSeed=true",
          "recalledNonceMatched=true",
          "threaded MPIM follow-up recovered the prior bot reply as assistant history",
        ].join("; ");
      },
      cleanup: closeOpenedChannel,
    };
  },
};

export const slackQaAllowlistBlockScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    allowFrom: ["U_OPENCLAW_QA_NEVER_ALLOWED"],
    users: ["U_OPENCLAW_QA_NEVER_ALLOWED"],
  },
  buildRun: (sutUserId) => {
    const token = `SLACK_QA_BLOCK_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      expectReply: false,
      input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
      matchText: token,
    };
  },
};

export const slackQaChannelDisabledWarningScenario: SlackQaScenarioImplementation = {
  configOverrides: { channelEnabled: false },
  buildRun: (sutUserId) => {
    const marker = `SLACK_QA_DISABLED_${randomUUID().slice(0, 8).toUpperCase()}`;
    let logCursor = 0;
    return {
      expectReply: false,
      input: `<@${sutUserId}> reply with only this exact marker: ${marker}`,
      matchText: marker,
      preserveGatewayDebug: true,
      beforeRun: async ({ gateway }) => {
        const gatewayLogTail = (await gateway.call(
          "logs.tail",
          { limit: 1, maxBytes: 32_000 },
          { timeoutMs: SLACK_QA_LOG_TAIL_TIMEOUT_MS },
        )) as { cursor?: unknown };
        logCursor = typeof gatewayLogTail.cursor === "number" ? gatewayLogTail.cursor : 0;
      },
      afterNoReply: async ({ gateway }) => {
        const gatewayLogTail = (await gateway.call(
          "logs.tail",
          { cursor: logCursor, limit: 200, maxBytes: 256_000 },
          { timeoutMs: SLACK_QA_LOG_TAIL_TIMEOUT_MS },
        )) as { lines?: unknown };
        const gatewayLogLines = Array.isArray(gatewayLogTail.lines)
          ? gatewayLogTail.lines.filter((line): line is string => typeof line === "string")
          : [];
        const expectedFields = [
          "Slack channel denied by configuration",
          "channel_not_allowed",
          "channel_disabled",
        ];
        if (
          !gatewayLogLines.some((line) => expectedFields.every((field) => line.includes(field)))
        ) {
          throw new Error("disabled Slack channel did not emit the structured warning");
        }
        return "structured disabled-channel warning observed";
      },
    };
  },
};

export const slackQaTopLevelReplyShapeScenario: SlackQaScenarioImplementation = {
  configOverrides: { replyToMode: "off" },
  buildRun: (sutUserId) => {
    const token = `SLACK_QA_TOPLEVEL_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      expectReply: true,
      input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
      matchText: token,
      verify: (message) => {
        if (message.thread_ts) {
          throw new Error(
            `expected top-level Slack reply without thread_ts; got ${message.thread_ts}`,
          );
        }
      },
    };
  },
};

export const slackQaProgressCommentaryTrueScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    progress: { commentary: true, toolProgress: false },
  },
  buildRun: (sutUserId) =>
    buildSlackProgressCommentaryRun(sutUserId, {
      commentary: "lane",
      toolProgress: "absent",
    }),
};

export const slackQaProgressCommentaryFalseScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    progress: { commentary: false, toolProgress: false },
  },
  buildRun: (sutUserId) =>
    buildSlackProgressCommentaryRun(sutUserId, {
      commentary: "headline",
      toolProgress: "absent",
    }),
};

export const slackQaProgressCommentaryOmittedScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    progress: { toolProgress: true },
  },
  buildRun: (sutUserId) =>
    buildSlackProgressCommentaryRun(sutUserId, {
      commentary: "headline",
      toolProgress: "draft",
    }),
};

export const slackQaProgressCommentaryVerboseDedupeScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    progress: { commentary: true, toolProgress: false, verboseDefault: "on" },
  },
  buildRun: (sutUserId) =>
    buildSlackProgressCommentaryRun(sutUserId, {
      commentary: "standalone",
      toolProgress: "standalone",
    }),
};

export const slackQaChartPresentationNativeScenario: SlackQaScenarioImplementation = {
  configOverrides: { messageTool: true },
  buildRun: (sutUserId) => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const summaryText = `SLACK_QA_CHART_SUMMARY_${suffix}`;
    const finalMarker = `SLACK_QA_CHART_DONE_${suffix}`;
    const messageToolArgs = buildSlackChartMessageToolArgs(summaryText);
    return {
      expectReply: true,
      input: [
        `<@${sutUserId}> Slack native chart QA check ${summaryText}.`,
        `Call the message tool exactly once with these exact arguments: ${JSON.stringify(messageToolArgs)}.`,
        `After the chart send succeeds, reply with only this exact marker: ${finalMarker}`,
      ].join(" "),
      matchText: finalMarker,
      afterReply: async (_message, context) => {
        await waitForSlackStoredMessage({
          channelId: context.channelId,
          client: context.sutReadClient,
          description: "message with native chart",
          matchesMessage: (message) =>
            isExpectedSlackNativeChartMessage(message, renderSlackChartAccessibleText(summaryText)),
          oldestTs: context.sentTs,
          sutIdentity: context.sutIdentity,
          timeoutMs: SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS,
        });
        return "verified native data_visualization block and deterministic accessible text";
      },
    };
  },
};

export const slackQaTablePresentationNativeScenario: SlackQaScenarioImplementation = {
  configOverrides: { messageTool: true },
  buildRun: (sutUserId) => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const summaryText = `SLACK_QA_TABLE_SUMMARY_${suffix}`;
    const messageToolArgs = buildSlackTableMessageToolArgs(summaryText);
    return {
      expectReply: true,
      input: [
        `<@${sutUserId}> Slack native table QA check ${summaryText}.`,
        `Call the message tool exactly once with these exact arguments: ${JSON.stringify(messageToolArgs)}.`,
      ].join(" "),
      matchText: summaryText,
      afterReply: async (_message, context) => {
        await waitForSlackStoredMessage({
          channelId: context.channelId,
          client: context.sutReadClient,
          description: "message with native table",
          matchesMessage: (message) =>
            isExpectedSlackNativeTableMessage(message, renderSlackTableAccessibleText(summaryText)),
          oldestTs: context.sentTs,
          sutIdentity: context.sutIdentity,
          timeoutMs: SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS,
        });
        return "verified native data_table block and deterministic accessible text";
      },
    };
  },
};

export const slackQaTableInvalidBlocksFallbackScenario: SlackQaScenarioImplementation = {
  buildRun: () => ({
    kind: "direct-transport",
    execute: runSlackTableInvalidBlocksFallbackScenario,
  }),
};

export const slackQaReactionGlyphNativeScenario: SlackQaScenarioImplementation = {
  configOverrides: { messageTool: true },
  buildRun: (sutUserId) => {
    const token = `SLACK_QA_REACTION_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      expectReply: true,
      input: [
        `<@${sutUserId}> use the message tool exactly once to react to this message.`,
        'Set action to "react", channel to "slack", and emoji to exactly "✅".',
        "Do not substitute a shortcode.",
        `After the reaction succeeds, reply with only this exact marker: ${token}`,
      ].join(" "),
      matchText: token,
      afterReply: async (_message, context) => {
        await waitForSlackReaction({
          channelId: context.channelId,
          client: context.sutReadClient,
          expectedReactionName: "white_check_mark",
          messageId: context.sentTs,
          sutUserId: context.sutIdentity.userId,
          timeoutMs: SLACK_QA_REACTION_VERIFY_TIMEOUT_MS,
        });
        return "verified SUT white_check_mark reaction from exact glyph instruction";
      },
    };
  },
};

export const slackQaApprovalExecNativeScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    approvals: {
      exec: true,
      target: "channel",
    },
  },
  buildRun: () => ({
    approvalKind: "exec",
    decision: "allow-once",
    kind: "approval",
    token: `SLACK_QA_EXEC_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
  }),
};

export const slackQaApprovalPluginNativeScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    approvals: {
      exec: true,
      plugin: true,
      target: "channel",
    },
  },
  buildRun: () => ({
    approvalKind: "plugin",
    decision: "allow-once",
    kind: "approval",
    token: `SLACK_QA_PLUGIN_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
  }),
};

export const slackQaCodexApprovalExecNativeScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    approvals: {
      exec: true,
      plugin: true,
      target: "channel",
    },
    codexApproval: true,
  },
  buildRun: () => ({
    approvalKind: "plugin",
    appServerMethod: "item/commandExecution/requestApproval",
    decision: "allow-once",
    kind: "codex-approval",
    token: `SLACK_QA_CODEX_EXEC_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
  }),
};

export const slackQaCodexApprovalPluginNativeScenario: SlackQaScenarioImplementation = {
  configOverrides: {
    approvals: {
      exec: true,
      plugin: true,
      target: "channel",
    },
    codexApproval: true,
  },
  buildRun: () => ({
    approvalKind: "plugin",
    appServerMethod: "item/fileChange/requestApproval",
    decision: "allow-once",
    kind: "codex-approval",
    token: `SLACK_QA_CODEX_FILE_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
  }),
};
