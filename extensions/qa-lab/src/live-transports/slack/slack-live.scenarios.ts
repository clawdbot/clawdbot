// QA Lab Slack live scenario catalog.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { waitForSlackReaction } from "./slack-live.codex-approval.js";
import {
  SLACK_QA_REACTION_VERIFY_TIMEOUT_MS,
  SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS,
  SLACK_QA_LOG_TAIL_TIMEOUT_MS,
  type SlackQaScenarioDefinition,
  type SlackQaScenarioContext,
} from "./slack-live.contracts.js";
import {
  isExpectedSlackNativeChartMessage,
  isExpectedSlackNativeTableMessage,
  runSlackTableInvalidBlocksFallbackScenario,
  waitForSlackStoredMessage,
} from "./slack-live.observations.js";
import {
  buildSlackChartMessageToolArgs,
  renderSlackChartAccessibleText,
  buildSlackTableMessageToolArgs,
  renderSlackTableAccessibleText,
  buildSlackProgressCommentaryRun,
} from "./slack-live.scenario-fixtures.js";

const SLACK_QA_SCENARIOS: SlackQaScenarioDefinition[] = [
  {
    id: "slack-canary",
    title: "Slack canary echo",
    timeoutMs: 45_000,
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
  {
    id: "slack-mention-gating",
    title: "Slack unmentioned bot message does not trigger",
    timeoutMs: 8_000,
    buildRun: () => {
      const token = `SLACK_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: false,
        input: `reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
  {
    id: "slack-mpim-app-mention-dedupe",
    title: "Slack MPIM app mention dispatches once",
    timeoutMs: 90_000,
    configOverrides: { groupDmEnabled: true },
    buildRun: (sutUserId) => {
      const token = `SLACK_QA_MPIM_${randomUUID().slice(0, 8).toUpperCase()}`;
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
        input: `<@${sutUserId}> reply with only this exact marker: ${token}`,
        matchText: token,
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
            message.text.includes(token),
          );
          if (uniqueReplies.size !== 1 || matchingReplies.length !== 1) {
            throw new Error(
              `expected one MPIM response with the marker, got ${uniqueReplies.size} response(s) and ${matchingReplies.length} marker match(es)`,
            );
          }
          return "one MPIM reply observed after message/app_mention twin delivery";
        },
        cleanup: closeOpenedChannel,
      };
    },
  },
  {
    id: "slack-allowlist-block",
    title: "Slack non-allowlisted sender does not trigger",
    timeoutMs: 8_000,
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
  },
  {
    id: "slack-channel-disabled-warning",
    title: "Slack disabled channel warns and does not trigger",
    timeoutMs: 8_000,
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
  },
  {
    id: "slack-top-level-reply-shape",
    title: "Slack top-level reply stays top-level",
    timeoutMs: 45_000,
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
  },
  {
    id: "slack-progress-commentary-true",
    title: "Slack progress commentary true is independent from tool progress",
    timeoutMs: 90_000,
    configOverrides: {
      progress: { commentary: true, toolProgress: false },
    },
    buildRun: (sutUserId) =>
      buildSlackProgressCommentaryRun(sutUserId, {
        commentary: "draft",
        toolProgress: "absent",
      }),
  },
  {
    id: "slack-progress-commentary-false",
    title: "Slack progress commentary false stays out of the progress draft",
    timeoutMs: 90_000,
    configOverrides: {
      progress: { commentary: false, toolProgress: false },
    },
    buildRun: (sutUserId) =>
      buildSlackProgressCommentaryRun(sutUserId, {
        commentary: "absent",
        toolProgress: "absent",
      }),
  },
  {
    id: "slack-progress-commentary-omitted",
    title: "Slack omitted progress commentary preserves the tool-progress default",
    timeoutMs: 90_000,
    configOverrides: {
      progress: { toolProgress: true },
    },
    buildRun: (sutUserId) =>
      buildSlackProgressCommentaryRun(sutUserId, {
        commentary: "draft",
        toolProgress: "draft",
      }),
  },
  {
    id: "slack-progress-commentary-verbose-dedupe",
    title: "Slack explicit commentary yields to durable verbose progress",
    timeoutMs: 90_000,
    configOverrides: {
      progress: { commentary: true, toolProgress: false, verboseDefault: "on" },
    },
    buildRun: (sutUserId) =>
      buildSlackProgressCommentaryRun(sutUserId, {
        commentary: "standalone",
        toolProgress: "standalone",
      }),
  },
  {
    id: "slack-chart-presentation-native",
    title: "Slack portable chart renders as a native data visualization",
    timeoutMs: 90_000,
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
              isExpectedSlackNativeChartMessage(
                message,
                renderSlackChartAccessibleText(summaryText),
              ),
            oldestTs: context.sentTs,
            sutIdentity: context.sutIdentity,
            timeoutMs: SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS,
          });
          return "verified native data_visualization block and deterministic accessible text";
        },
      };
    },
  },
  {
    id: "slack-table-presentation-native",
    title: "Slack portable table renders as a native data table",
    timeoutMs: 90_000,
    configOverrides: { messageTool: true },
    buildRun: (sutUserId) => {
      const suffix = randomUUID().slice(0, 8).toUpperCase();
      const summaryText = `SLACK_QA_TABLE_SUMMARY_${suffix}`;
      const finalMarker = `SLACK_QA_TABLE_DONE_${suffix}`;
      const messageToolArgs = buildSlackTableMessageToolArgs(summaryText);
      return {
        expectReply: true,
        input: [
          `<@${sutUserId}> Slack native table QA check ${summaryText}.`,
          `Call the message tool exactly once with these exact arguments: ${JSON.stringify(messageToolArgs)}.`,
          `After the table send succeeds, reply with only this exact marker: ${finalMarker}`,
        ].join(" "),
        matchText: finalMarker,
        afterReply: async (_message, context) => {
          await waitForSlackStoredMessage({
            channelId: context.channelId,
            client: context.sutReadClient,
            description: "message with native table",
            matchesMessage: (message) =>
              isExpectedSlackNativeTableMessage(
                message,
                renderSlackTableAccessibleText(summaryText),
              ),
            oldestTs: context.sentTs,
            sutIdentity: context.sutIdentity,
            timeoutMs: SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS,
          });
          return "verified native data_table block and deterministic accessible text";
        },
      };
    },
  },
  {
    id: "slack-table-invalid-blocks-fallback",
    title: "Slack rejects an over-limit native table and stores its complete fallback",
    timeoutMs: 45_000,
    buildRun: () => ({
      kind: "direct-transport",
      execute: runSlackTableInvalidBlocksFallbackScenario,
    }),
  },
  {
    id: "slack-reaction-glyph-native",
    title: "Slack message tool normalizes an emoji glyph reaction",
    timeoutMs: 90_000,
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
  },
  {
    id: "slack-approval-exec-native",
    title: "Slack native exec approval prompt resolves",
    timeoutMs: 60_000,
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
  },
  {
    id: "slack-approval-plugin-native",
    title: "Slack native plugin approval prompt resolves with exec approvals enabled",
    timeoutMs: 60_000,
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
  },
  {
    id: "slack-codex-approval-exec-native",
    title: "Slack native Codex command approval prompt resolves",
    timeoutMs: 180_000,
    configOverrides: {
      approvals: {
        exec: true,
        plugin: true,
        target: "channel",
      },
      codexApproval: true,
    },
    forcedRuntime: "codex",
    buildRun: () => ({
      approvalKind: "plugin",
      appServerMethod: "item/commandExecution/requestApproval",
      decision: "allow-once",
      kind: "codex-approval",
      token: `SLACK_QA_CODEX_EXEC_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
  {
    id: "slack-codex-approval-plugin-native",
    title: "Slack native Codex file approval prompt resolves",
    timeoutMs: 180_000,
    configOverrides: {
      approvals: {
        exec: true,
        plugin: true,
        target: "channel",
      },
      codexApproval: true,
    },
    forcedRuntime: "codex",
    buildRun: () => ({
      approvalKind: "plugin",
      appServerMethod: "item/fileChange/requestApproval",
      decision: "allow-once",
      kind: "codex-approval",
      token: `SLACK_QA_CODEX_FILE_APPROVAL_${randomUUID().slice(0, 8).toUpperCase()}`,
    }),
  },
];

export function listSlackQaScenarioCatalog() {
  return SLACK_QA_SCENARIOS.map((scenario) => ({ id: scenario.id }));
}

export function getSlackQaScenarioDefinition(id: string) {
  const scenario = SLACK_QA_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`unknown Slack QA scenario id: ${id}`);
  }
  return scenario;
}
