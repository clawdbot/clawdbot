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
  toolProgress: "absent" | "draft" | "standalone";
};

const SLACK_COMMENTARY_DIAGNOSTIC_MAX_OBSERVATIONS = 16;
const SLACK_COMMENTARY_DIAGNOSTIC_MAX_BLOCK_ENTRIES = 16;
const SLACK_COMMENTARY_DIAGNOSTIC_MAX_BYTES = 512;
const SLACK_COMMENTARY_DIAGNOSTIC_FALLBACK =
  'expected commentary in the Slack progress commentary lane; portable renderer expected one exact italic line; observed {"v":1,"observed":0,"sampled":0,"observationsTruncated":false,"withBlocks":0,"sampledBlockEntries":0,"blockEntriesTruncated":false,"italicText":0,"glyphText":0,"multilineText":0,"otherText":0,"withUpdateBlock":0}';

function observedSlackText(message: { blockText?: string[]; text: string }) {
  return [message.text, ...(message.blockText ?? [])].join("\n");
}

function hasSlackCommentaryLaneMarker(
  message: { blockText?: string[]; text: string },
  marker: string,
) {
  const portableCommentary = /^_([^\r\n]+)_$/u.exec(message.text.trim())?.[1];
  if (message.text.includes(`💬 ${marker}`) || portableCommentary === marker) {
    return true;
  }
  const blockText = message.blockText ?? [];
  return (
    blockText.some((text) => text.trim() === "Update") &&
    blockText.some((text) => text.includes(marker))
  );
}

function describeSlackCommentaryLaneMismatch(
  messages: ReadonlyArray<{ blockText?: string[]; text: string }>,
) {
  const sampledMessages = messages.slice(0, SLACK_COMMENTARY_DIAGNOSTIC_MAX_OBSERVATIONS);
  let withBlocks = 0;
  let sampledBlockEntries = 0;
  let blockEntriesTruncated = false;
  let italicText = 0;
  let glyphText = 0;
  let multilineText = 0;
  let otherText = 0;
  let withUpdateBlock = 0;

  for (const message of sampledMessages) {
    const text = message.text.trim();
    if (/[\r\n]/u.test(text)) {
      multilineText += 1;
    } else if (/^_[^\r\n]+_$/u.test(text)) {
      italicText += 1;
    } else if (/^(?:🧠|💬)\s/u.test(text)) {
      glyphText += 1;
    } else {
      otherText += 1;
    }

    const blockText = message.blockText ?? [];
    if (blockText.length > 0) {
      withBlocks += 1;
    }
    const sampledBlocks = blockText.slice(0, SLACK_COMMENTARY_DIAGNOSTIC_MAX_BLOCK_ENTRIES);
    sampledBlockEntries += sampledBlocks.length;
    blockEntriesTruncated ||= blockText.length > sampledBlocks.length;
    withUpdateBlock += sampledBlocks.some((entry) => entry.trim() === "Update") ? 1 : 0;
  }

  const observationsTruncated = messages.length > sampledMessages.length;
  const summary = {
    v: 1,
    observed: observationsTruncated
      ? (`${SLACK_COMMENTARY_DIAGNOSTIC_MAX_OBSERVATIONS}+` as const)
      : messages.length,
    sampled: sampledMessages.length,
    observationsTruncated,
    withBlocks,
    sampledBlockEntries,
    blockEntriesTruncated,
    italicText,
    glyphText,
    multilineText,
    otherText,
    withUpdateBlock,
  };
  const diagnostic = [
    "expected commentary in the Slack progress commentary lane",
    "portable renderer expected one exact italic line",
    `observed ${JSON.stringify(summary)}`,
  ].join("; ");
  return new TextEncoder().encode(diagnostic).byteLength <= SLACK_COMMENTARY_DIAGNOSTIC_MAX_BYTES
    ? diagnostic
    : SLACK_COMMENTARY_DIAGNOSTIC_FALLBACK;
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
      const progressMessages = messages.filter(
        (message) => !observedSlackText(message).includes(finalMarker),
      );
      const commentaryMessages = progressMessages.filter((message) =>
        observedSlackText(message).includes(commentaryMarker),
      );
      const commentaryTimestamps = new Set(commentaryMessages.map((message) => message.ts));
      const [commentaryTs] = commentaryTimestamps;
      if (commentaryTimestamps.size !== 1 || commentaryTs === undefined) {
        throw new Error(
          `expected exactly one Slack message identity containing commentary; got ${commentaryTimestamps.size}`,
        );
      }
      if (commentaryTs === finalMessage.ts) {
        throw new Error("expected Slack progress commentary to stay separate from the fresh final");
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
          throw new Error(describeSlackCommentaryLaneMismatch(commentaryMessages));
        }
        if (expectation.commentary === "headline" && commentaryLaneTimestamps.size !== 0) {
          throw new Error("expected the preamble as the Slack progress status headline");
        }
      }
      const toolTimestamps = new Set(
        progressMessages
          .filter((message) => observedSlackText(message).includes(toolMarker))
          .map((message) => message.ts),
      );
      if (expectation.toolProgress === "draft") {
        if (toolTimestamps.size !== 1 || toolTimestamps.has(finalMessage.ts)) {
          throw new Error("expected tool progress on the draft separate from the fresh final");
        }
        if (expectation.commentary !== "standalone" && !toolTimestamps.has(commentaryTs)) {
          throw new Error("expected commentary and tool progress on one Slack draft identity");
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
        expectation.commentary === "lane"
          ? "commentary in the progress lane"
          : expectation.commentary === "standalone"
            ? "one standalone commentary identity"
            : "preamble in the progress status headline";
      return `verified ${commentaryDetails}; tool progress ${expectation.toolProgress}; final identity unique`;
    },
  };
}
