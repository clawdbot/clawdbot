// QA Lab Slack presentation and progress scenario fixtures.
import { randomUUID } from "node:crypto";
import {
  SLACK_QA_CHART_TITLE,
  SLACK_QA_CHART_CATEGORIES,
  SLACK_QA_CHART_SERIES_NAME,
  SLACK_QA_CHART_VALUES,
  SLACK_QA_CHART_X_LABEL,
  SLACK_QA_CHART_Y_LABEL,
  SLACK_QA_TABLE_CAPTION,
  SLACK_QA_TABLE_HEADERS,
  SLACK_QA_TABLE_ROWS,
  type SlackQaMessageScenarioRun,
} from "./slack-live.contracts.js";

export function buildSlackChartMessageToolArgs(summaryText: string) {
  return {
    action: "send",
    message: summaryText,
    presentation: {
      blocks: [
        {
          type: "chart",
          chartType: "line",
          title: SLACK_QA_CHART_TITLE,
          categories: [...SLACK_QA_CHART_CATEGORIES],
          series: [{ name: SLACK_QA_CHART_SERIES_NAME, values: [...SLACK_QA_CHART_VALUES] }],
          xLabel: SLACK_QA_CHART_X_LABEL,
          yLabel: SLACK_QA_CHART_Y_LABEL,
        },
      ],
    },
  };
}

export function renderSlackChartAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    `${SLACK_QA_CHART_TITLE} (line chart)`,
    `X axis: ${SLACK_QA_CHART_X_LABEL}`,
    `Y axis: ${SLACK_QA_CHART_Y_LABEL}`,
    `- ${SLACK_QA_CHART_SERIES_NAME}: ${SLACK_QA_CHART_CATEGORIES[0]}: ${SLACK_QA_CHART_VALUES[0]}; ${SLACK_QA_CHART_CATEGORIES[1]}: ${SLACK_QA_CHART_VALUES[1]}`,
  ].join("\n");
}

export function buildSlackTableMessageToolArgs(summaryText: string) {
  return {
    action: "send",
    message: summaryText,
    presentation: {
      blocks: [
        {
          type: "table",
          caption: SLACK_QA_TABLE_CAPTION,
          headers: [...SLACK_QA_TABLE_HEADERS],
          rows: SLACK_QA_TABLE_ROWS.map((row) => [...row]),
          rowHeaderColumnIndex: 0,
        },
      ],
    },
  };
}

export function renderSlackTableAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    `${SLACK_QA_TABLE_CAPTION} (table)`,
    SLACK_QA_TABLE_HEADERS.join("\t"),
    ...SLACK_QA_TABLE_ROWS.map((row) => row.join("\t")),
  ].join("\n");
}

type SlackProgressCommentaryExpectation = {
  commentary: "absent" | "draft" | "standalone";
  toolProgress: "absent" | "draft" | "standalone";
};

export function buildSlackProgressCommentaryRun(
  sutUserId: string,
  expectation: SlackProgressCommentaryExpectation,
): SlackQaMessageScenarioRun {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  // Slack mrkdwn escapes underscores in progress drafts. Hyphenated markers
  // stay byte-identical across draft edits and final-message reads.
  const commentaryMarker = `SLACK-QA-COMMENTARY-${suffix}`;
  const toolMarker = `SLACK-QA-TOOL-${suffix}`;
  const finalMarker = `SLACK-QA-COMMENTARY-DONE-${suffix}`;
  return {
    expectReply: true,
    input: [
      `<@${sutUserId}> This is a Slack progress protocol test. First, emit an assistant commentary message whose entire text is exactly ${commentaryMarker}.`,
      "Do not call any tool until that commentary message is complete.",
      `Then use the exec tool exactly once to run: grep '${toolMarker}' /dev/null || sleep 5.`,
      `After the command finishes, reply with only this exact marker: ${finalMarker}`,
    ].join(" "),
    matchText: finalMarker,
    settleObservedMs: 3_000,
    verifyObserved: ({ finalMessage, messages }) => {
      if (!finalMessage.ts) {
        throw new Error("Slack progress commentary final message had no ts");
      }
      if ((finalMessage.text ?? "").trim() !== finalMarker) {
        throw new Error("expected the Slack final answer to contain only the final marker");
      }
      const progressMessages = messages.filter((message) => !message.text.includes(finalMarker));
      const commentaryMessages = progressMessages.filter((message) =>
        message.text.includes(commentaryMarker),
      );
      const commentaryTimestamps = new Set(commentaryMessages.map((message) => message.ts));
      if (expectation.commentary === "absent" && commentaryTimestamps.size !== 0) {
        throw new Error("expected commentary to stay out of Slack progress messages");
      }
      if (expectation.commentary !== "absent" && commentaryTimestamps.size !== 1) {
        throw new Error(
          `expected exactly one Slack message identity containing commentary; got ${commentaryTimestamps.size}`,
        );
      }
      const commentaryTs = [...commentaryTimestamps][0];
      if (expectation.commentary === "draft" && commentaryTs !== finalMessage.ts) {
        throw new Error("expected commentary on the progress draft finalized as the answer");
      }
      if (expectation.commentary === "standalone" && commentaryTs === finalMessage.ts) {
        throw new Error("expected commentary only in the standalone verbose message");
      }
      const toolTimestamps = new Set(
        progressMessages
          .filter((message) => message.text.includes(toolMarker))
          .map((message) => message.ts),
      );
      if (expectation.toolProgress === "draft") {
        if (toolTimestamps.size !== 1 || !toolTimestamps.has(finalMessage.ts)) {
          throw new Error("expected tool progress on the progress draft finalized as the answer");
        }
      } else if (expectation.toolProgress === "standalone") {
        if (toolTimestamps.size === 0 || toolTimestamps.has(finalMessage.ts)) {
          throw new Error("expected tool progress only in standalone verbose messages");
        }
      } else if (toolTimestamps.size !== 0) {
        throw new Error("expected tool progress to stay out of Slack progress messages");
      }
      const finalTimestamps = new Set(
        messages
          .filter((message) => message.text.includes(finalMarker))
          .map((message) => message.ts),
      );
      if (finalTimestamps.size !== 1 || !finalTimestamps.has(finalMessage.ts)) {
        throw new Error(
          "expected one final-marker Slack message identity matching the final answer",
        );
      }
      const commentaryDetails =
        expectation.commentary === "draft"
          ? "commentary on progress/final identity"
          : expectation.commentary === "standalone"
            ? "one standalone commentary identity"
            : "commentary absent from Slack progress";
      return `verified ${commentaryDetails}; tool progress ${expectation.toolProgress}; final identity unique`;
    },
  };
}
