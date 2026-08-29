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
  commentary: "headline" | "lane" | "standalone";
  toolProgress: "absent" | "draft" | "standalone" | "standalone-redacted";
};

function observedSlackText(message: { blockText?: string[]; text: string }) {
  return [message.text, ...(message.blockText ?? [])].join("\n");
}

function hasSlackCommentaryLaneMarker(
  message: { blockText?: string[]; text: string },
  marker: string,
) {
  if (message.text.includes(`💬 ${marker}`) || message.text.trim() === `_${marker}_`) {
    return true;
  }
  const blockText = message.blockText ?? [];
  return blockText.some((text) => text.trim() === `• *Update* — ${marker}`);
}

function isSlackSafeExecSummary(message: { text: string }) {
  // Slack history converts Unicode emoji to colon names; captured writes retain Unicode.
  return /^(?:🛠️|:hammer_and_wrench:) Exec$/u.test(message.text.trim());
}

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
      `Then use the exec tool exactly once to run: sleep 5 # ${toolMarker}.`,
      `After the command finishes, reply with only this exact marker: ${finalMarker}`,
    ].join(" "),
    matchText: finalMarker,
    settleObservedMs: 3_000,
    verifyObserved: ({ finalMessage, messages }) => {
      function fail(reason: string): never {
        const identities = new Map<string, number>();
        // Failure artifacts may be public. Emit only closed presentation facts,
        // never message text, platform ids, command text, or credential fields.
        const presentation = messages.slice(-16).map((message) => {
          if (message.ts && !identities.has(message.ts)) {
            identities.set(message.ts, identities.size + 1);
          }
          const text = message.text.trim();
          return {
            identity: message.ts ? identities.get(message.ts) : 0,
            final: observedSlackText(message).includes(finalMarker),
            commentary: observedSlackText(message).includes(commentaryMarker),
            commentaryLane: hasSlackCommentaryLaneMarker(message, commentaryMarker),
            bareCommentary: text === commentaryMarker,
            colonCommentary: text === `:speech_balloon: ${commentaryMarker}`,
            typedCommentaryBlock: (message.blockText ?? []).some(
              (line) => line.trim() === `• *Commentary* — _${commentaryMarker}_`,
            ),
            safeExec: isSlackSafeExecSummary(message),
            commandMarker: observedSlackText(message).includes(toolMarker),
          };
        });
        throw new Error(`${reason}; presentation=${JSON.stringify(presentation)}`);
      }
      if (!finalMessage.ts) {
        fail("Slack progress commentary final message had no ts");
      }
      if ((finalMessage.text ?? "").trim() !== finalMarker) {
        fail("expected the Slack final answer to contain only the final marker");
      }
      const progressMessages = messages.filter(
        (message) => !observedSlackText(message).includes(finalMarker),
      );
      const commentaryMessages = progressMessages.filter((message) =>
        observedSlackText(message).includes(commentaryMarker),
      );
      const commentaryTimestamps = new Set(commentaryMessages.map((message) => message.ts));
      const [commentaryTs] = commentaryTimestamps;
      if (commentaryTimestamps.size !== 1 || commentaryTs === undefined) {
        fail(
          `expected exactly one Slack message identity containing commentary; got ${commentaryTimestamps.size}`,
        );
      }
      if (commentaryTs === finalMessage.ts) {
        fail("expected Slack progress commentary to stay separate from the fresh final");
      }
      // Slack prefixes durable standalone commentary with the same glyph used by
      // draft-lane rendering, so message identity—not that marker—owns dedupe proof.
      if (expectation.commentary !== "standalone") {
        const commentaryLaneTimestamps = new Set(
          commentaryMessages
            .filter((message) => hasSlackCommentaryLaneMarker(message, commentaryMarker))
            .map((message) => message.ts),
        );
        if (
          expectation.commentary === "lane" &&
          (commentaryLaneTimestamps.size !== 1 || !commentaryLaneTimestamps.has(commentaryTs))
        ) {
          fail("expected commentary in the Slack progress commentary lane");
        }
        if (expectation.commentary === "headline" && commentaryLaneTimestamps.size !== 0) {
          fail("expected the preamble as the Slack progress status headline");
        }
      }
      const toolTimestamps = new Set(
        progressMessages
          .filter((message) => observedSlackText(message).includes(toolMarker))
          .map((message) => message.ts),
      );
      if (expectation.toolProgress === "standalone-redacted") {
        if (messages.some((message) => observedSlackText(message).includes(toolMarker))) {
          fail("command details must stay hidden in verbose-on progress");
        }
        const safeToolTimestamps = new Set(
          progressMessages.filter(isSlackSafeExecSummary).map((message) => message.ts),
        );
        if (
          safeToolTimestamps.size !== 1 ||
          safeToolTimestamps.has(commentaryTs) ||
          safeToolTimestamps.has(finalMessage.ts)
        ) {
          fail("expected one safe Exec summary in a standalone verbose message");
        }
      } else if (expectation.toolProgress === "draft") {
        if (toolTimestamps.size !== 1 || toolTimestamps.has(finalMessage.ts)) {
          fail("expected tool progress on the draft separate from the fresh final");
        }
        if (expectation.commentary !== "standalone" && !toolTimestamps.has(commentaryTs)) {
          fail("expected commentary and tool progress on one Slack draft identity");
        }
      } else if (expectation.toolProgress === "standalone") {
        if (
          toolTimestamps.size === 0 ||
          toolTimestamps.has(commentaryTs) ||
          toolTimestamps.has(finalMessage.ts)
        ) {
          fail("expected tool progress only in standalone verbose messages");
        }
      } else if (toolTimestamps.size !== 0) {
        fail("expected tool progress to stay out of Slack progress messages");
      }
      const finalTimestamps = new Set(
        messages
          .filter((message) => message.text.includes(finalMarker))
          .map((message) => message.ts),
      );
      if (finalTimestamps.size !== 1 || !finalTimestamps.has(finalMessage.ts)) {
        fail("expected one final-marker Slack message identity matching the final answer");
      }
      const commentaryDetails =
        expectation.commentary === "lane"
          ? "commentary in the progress lane"
          : expectation.commentary === "standalone"
            ? "one standalone commentary identity"
            : "preamble in the progress status headline";
      return `verified ${commentaryDetails}; tool progress ${expectation.toolProgress}; final identity unique`;
    },
  };
}
