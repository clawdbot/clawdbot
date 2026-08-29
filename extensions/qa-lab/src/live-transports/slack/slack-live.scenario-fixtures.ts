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
  // A progress card can contain several authored rows within one Slack message.
  if (
    message.text
      .split(/\r?\n/u)
      .some((line) =>
        [`💬 ${marker}`, `:speech_balloon: ${marker}`, `_${marker}_`].includes(line.trim()),
      )
  ) {
    return true;
  }
  const blockText = message.blockText ?? [];
  return blockText.some((text) =>
    text.split(/\r?\n/u).some((line) => line.trim() === `• *Commentary* — _${marker}_`),
  );
}

function isSlackSafeExecSummary(message: { text: string }) {
  // Slack history converts Unicode emoji to colon names; captured writes retain Unicode.
  return /^(?:🛠️|:hammer_and_wrench:) Exec$/u.test(message.text.trim());
}

function slackMarkerEnvelope(text: string, marker: string) {
  const line = text.split(/\r?\n/u).find((value) => value.includes(marker));
  if (line === undefined) {
    return "missing";
  }
  const index = line.indexOf(marker);
  const classify = (value: string) => {
    const edge = value.trim();
    if (!edge) {
      return "none";
    }
    if (/^(?:•\s+)?\*Commentary\*\s+—\s*_?$/u.test(edge)) {
      return "commentary-row";
    }
    if (/^(?:•\s+)?\*Update\*\s+—\s*$/u.test(edge)) {
      return "update-row";
    }
    if (/^(?:💬|:speech_balloon:)$/u.test(edge)) {
      return "emoji";
    }
    if (edge === "\\_") {
      return "escaped-italic";
    }
    if (edge === "_") {
      return "italic";
    }
    if (/^\*{1,2}$/u.test(edge)) {
      return "bold";
    }
    if (/^`{1,3}$/u.test(edge)) {
      return "code";
    }
    if (/^>+$/u.test(edge)) {
      return "quote";
    }
    return /^[•+-]$/u.test(edge) ? "bullet" : "other";
  };
  return `${classify(line.slice(0, index))}/${classify(line.slice(index + marker.length))}`;
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
  const outputMarker = `SLACK-QA-OUTPUT-${suffix}`;
  const finalMarker = `SLACK-QA-COMMENTARY-DONE-${suffix}`;
  return {
    expectReply: true,
    input: [
      `<@${sutUserId}> This is a Slack progress protocol test. First, emit an assistant commentary message whose entire text is exactly ${commentaryMarker}.`,
      "Do not call any tool until that commentary message is complete.",
      `Then use the exec tool exactly once to run this exact command: \`sleep 5; printf '%s\\n' '${outputMarker}' # ${toolMarker}\`.`,
      `After the command finishes, reply with only this exact marker: ${finalMarker}`,
    ].join(" "),
    matchText: finalMarker,
    settleObservedMs: 3_000,
    verifyObserved: ({ finalMessage, messages }) => {
      function fail(reason: string): never {
        const identities = new Map<string, number>();
        // Failure artifacts may be public. Emit only closed presentation facts,
        // never message text, platform ids, command text, or credential fields.
        const presentation = new Set<string>();
        for (const message of messages) {
          if (message.ts && !identities.has(message.ts)) {
            identities.set(message.ts, identities.size + 1);
          }
          const texts = [message.text, (message.blockText ?? []).join("\n")];
          const observedText = observedSlackText(message);
          const facts = JSON.stringify({
            identity: message.ts ? identities.get(message.ts) : 0,
            final: observedText.includes(finalMarker),
            lane: hasSlackCommentaryLaneMarker(message, commentaryMarker),
            text: slackMarkerEnvelope(texts[0]!, commentaryMarker),
            block: slackMarkerEnvelope(texts[1]!, commentaryMarker),
            lines: texts.map((text) => (text ? Math.min(9, text.split(/\r?\n/u).length) : 0)),
            occurrences: texts.map((text) => Math.min(2, text.split(commentaryMarker).length - 1)),
            tool: observedText.includes(toolMarker)
              ? "command-marker"
              : isSlackSafeExecSummary(message)
                ? "safe-exec"
                : /\bsleep\s+5\b/u.test(observedText)
                  ? "sleep-without-marker"
                  : "other",
          });
          // Repeated history polls must not crowd the distinct captured writes
          // out of the bounded failure artifact. Assertions still see every write.
          presentation.delete(facts);
          presentation.add(facts);
          if (presentation.size > 16) {
            presentation.delete(presentation.values().next().value!);
          }
        }
        throw new Error(`${reason}; presentation=[${[...presentation].join(",")}]`);
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
        if (
          messages.some((message) =>
            [toolMarker, outputMarker].some((marker) =>
              observedSlackText(message).includes(marker),
            ),
          )
        ) {
          fail("command details and output must stay hidden in verbose-on progress");
        }
        const safeToolTimestamps = new Set(
          progressMessages.filter(isSlackSafeExecSummary).map((message) => message.ts),
        );
        if (
          safeToolTimestamps.size !== 1 ||
          safeToolTimestamps.has(undefined) ||
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
        if (messages.some((message) => observedSlackText(message).includes(toolMarker))) {
          fail("command details must stay hidden in standalone channel tool output");
        }
        const toolMessages = progressMessages.filter((message) =>
          isSlackSafeExecSummary({ text: message.text.split(/\r?\n/u)[0] ?? "" }),
        );
        const toolMessageTimestamps = new Set(toolMessages.map((message) => message.ts));
        const outputTimestamps = new Set(
          toolMessages
            .filter((message) =>
              observedSlackText(message)
                .split(/\r?\n/u)
                .some((line) => line.trim() === outputMarker),
            )
            .map((message) => message.ts),
        );
        if (
          toolMessageTimestamps.size !== 1 ||
          outputTimestamps.size !== 1 ||
          outputTimestamps.has(undefined) ||
          outputTimestamps.has(commentaryTs) ||
          outputTimestamps.has(finalMessage.ts)
        ) {
          fail("expected exact tool output in one standalone verbose message");
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
