// Qa Lab plugin module implements slack live behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSlackWebClient,
  createSlackWriteClient,
  listSlackReactions,
  sendSlackMessage,
} from "@openclaw/slack/api.js";
import type { WebClient } from "@slack/web-api";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { createQaArtifactRunId } from "../../artifact-run-id.js";
import { QA_EVIDENCE_FILENAME, buildLiveTransportEvidenceSummary } from "../../evidence-summary.js";
import { startQaGatewayChild } from "../../gateway-child.js";
import { extractGatewayMessageText } from "../../gateway-log-sentinel.js";
import { isTruthyOptIn } from "../../mantis-options.runtime.js";
import { splitQaModelRef } from "../../model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import type { RuntimeId } from "../../runtime-parity.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import {
  assertApprovalDecisionResult,
  formatApprovalResultValue,
  readAcceptedApprovalRequestId,
} from "../shared/live-approval-result.js";
import {
  appendQaLiveLaneIssue as appendLiveLaneIssue,
  buildQaLiveLaneArtifactsError as buildLiveLaneArtifactsError,
} from "../shared/live-artifacts.js";
import { inferQaCredentialSource as inferSlackCredentialSource } from "../shared/live-credential-source.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../shared/live-transport-scenarios.js";

type SlackQaRuntimeEnv = {
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutAppToken: string;
};

type SlackChannelStatus = {
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string | null;
  restartPending?: boolean;
  running?: boolean;
};

type SlackChannelReadinessMode = "connected" | "started";

const SLACK_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;
const SLACK_QA_READY_STABILITY_MS = 3_000;
const SLACK_QA_GATEWAY_STOP_SETTLE_MS = 3_000;
const SLACK_QA_RETRYABLE_SCENARIO_ATTEMPTS = 2;
const SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS = 30_000;
const SLACK_QA_APPROVAL_CHECKPOINT_DEFAULT_TIMEOUT_MS = 120_000;
const SLACK_QA_REACTION_VERIFY_TIMEOUT_MS = 15_000;
const SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS = 15_000;
const SLACK_QA_INVALID_TABLE_DATA_ROW_COUNT = 101;
const SLACK_QA_LOG_TAIL_TIMEOUT_MS = 20_000;
const SLACK_QA_INVALID_TABLE_CAPTION = "QA invalid_blocks fallback";
const SLACK_QA_INVALID_TABLE_HEADERS = ["Row", "Value"] as const;
const SLACK_QA_CHART_TITLE = "QA latency trend";
const SLACK_QA_CHART_CATEGORIES = ["P50", "P95"] as const;
const SLACK_QA_CHART_SERIES_NAME = "Latency";
const SLACK_QA_CHART_VALUES = [120, 240] as const;
const SLACK_QA_CHART_X_LABEL = "Percentile";
const SLACK_QA_CHART_Y_LABEL = "Milliseconds";
const SLACK_QA_TABLE_CAPTION = "QA pipeline report";
const SLACK_QA_TABLE_HEADERS = ["Account", "Stage", "ARR"] as const;
const SLACK_QA_TABLE_ROWS = [
  ["Acme", "Won", 125_000],
  ["Globex", "Review", 82_000],
] as const;
const SLACK_QA_NATIVE_CHART = {
  type: "data_visualization",
  title: SLACK_QA_CHART_TITLE,
  chart: {
    type: "line",
    series: [
      {
        name: SLACK_QA_CHART_SERIES_NAME,
        data: [
          { label: SLACK_QA_CHART_CATEGORIES[0], value: SLACK_QA_CHART_VALUES[0] },
          { label: SLACK_QA_CHART_CATEGORIES[1], value: SLACK_QA_CHART_VALUES[1] },
        ],
      },
    ],
    axis_config: {
      categories: [...SLACK_QA_CHART_CATEGORIES],
      x_label: SLACK_QA_CHART_X_LABEL,
      y_label: SLACK_QA_CHART_Y_LABEL,
    },
  },
} as const;
const SLACK_QA_NATIVE_TABLE = {
  type: "data_table",
  caption: SLACK_QA_TABLE_CAPTION,
  rows: [
    SLACK_QA_TABLE_HEADERS.map((text) => ({ type: "raw_text", text })),
    ...SLACK_QA_TABLE_ROWS.map((row) =>
      row.map((cell) =>
        typeof cell === "number"
          ? { type: "raw_number", value: cell, text: String(cell) }
          : { type: "raw_text", text: cell },
      ),
    ),
  ],
  row_header_column_index: 0,
} as const;
// These scenarios force the Codex harness, whose default provider set is intentionally narrow.
const SLACK_QA_CODEX_PROVIDER_IDS = new Set(["codex", "openai"]);

type SlackQaScenarioId =
  | "slack-allowlist-block"
  | "slack-approval-exec-native"
  | "slack-approval-plugin-native"
  | "slack-canary"
  | "slack-codex-approval-exec-native"
  | "slack-codex-approval-plugin-native"
  | "slack-chart-presentation-native"
  | "slack-channel-disabled-warning"
  | "slack-mention-gating"
  | "slack-progress-commentary-false"
  | "slack-progress-commentary-omitted"
  | "slack-progress-commentary-true"
  | "slack-progress-commentary-verbose-dedupe"
  | "slack-reaction-glyph-native"
  | "slack-table-invalid-blocks-fallback"
  | "slack-table-presentation-native"
  | "slack-top-level-reply-shape";

type SlackQaApprovalKind = "exec" | "plugin";
type SlackQaApprovalDecision = "allow-always" | "allow-once" | "deny";
const SLACK_QA_APPROVAL_ACTION_PREFIX = "openclaw:approval:v1:";
const SlackQaApprovalActionValueSchema = z
  .object({
    approvalId: z.string().min(1),
    approvalKind: z.enum(["exec", "plugin"]),
    decision: z.enum(["allow-always", "allow-once", "deny"]),
  })
  .strict();
type SlackQaCodexApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval";

function assertSlackCodexApprovalModelSupported(modelRef: string) {
  const provider = splitQaModelRef(modelRef)?.provider.trim().toLowerCase();
  if (provider && SLACK_QA_CODEX_PROVIDER_IDS.has(provider)) {
    return;
  }
  throw new Error(
    `Slack Codex approval scenarios require an openai/* or codex/* model; received "${modelRef}".`,
  );
}

function resolveSlackQaSutAccountId(value?: string) {
  return normalizeAccountId(value?.trim() || "sut");
}

type SlackQaMessageScenarioRun = {
  afterNoReply?: (context: SlackQaScenarioContext) => Promise<string | void>;
  kind?: "message";
  expectReply: boolean;
  input: string;
  matchText: string;
  preserveGatewayDebug?: boolean;
  settleObservedMs?: number;
  verify?: (message: SlackMessage, context: { requestThreadTs: string; sentTs: string }) => void;
  verifyObserved?: (params: {
    finalMessage: SlackMessage;
    messages: readonly SlackObservedMessage[];
  }) => string | void;
  beforeRun?: (context: Omit<SlackQaScenarioContext, "sentTs">) => Promise<SlackQaBeforeRunResult>;
  afterReply?: (message: SlackMessage, context: SlackQaScenarioContext) => Promise<string | void>;
};

type SlackQaDirectTransportScenarioRun = {
  kind: "direct-transport";
  execute: (
    context: SlackQaDirectTransportScenarioContext,
  ) => Promise<SlackQaDirectTransportScenarioResult>;
};

type SlackQaDirectTransportScenarioContext = {
  cfg: OpenClawConfig;
  channelId: string;
  sutAccountId: string;
  sutIdentity: SlackAuthIdentity;
  sutReadClient: WebClient;
  sutWriteClient: WebClient;
  timeoutMs: number;
};

type SlackQaDirectTransportScenarioResult = {
  details: string;
  message: SlackMessage;
};

type SlackQaApprovalScenarioRun = {
  approvalKind: SlackQaApprovalKind;
  decision: SlackQaApprovalDecision;
  kind: "approval";
  token: string;
};

type SlackQaCodexApprovalScenarioRun = {
  approvalKind: "plugin";
  appServerMethod: SlackQaCodexApprovalMethod;
  decision: "allow-once";
  kind: "codex-approval";
  token: string;
};

type SlackQaScenarioRun =
  | SlackQaApprovalScenarioRun
  | SlackQaCodexApprovalScenarioRun
  | SlackQaDirectTransportScenarioRun
  | SlackQaMessageScenarioRun;

type SlackQaBeforeRunResult =
  | string
  | void
  | {
      details?: string;
      inputThreadTs?: string;
    };

type SlackQaConfigOverrides = {
  allowFrom?: string[];
  channelEnabled?: boolean;
  approvals?: {
    exec?: boolean;
    plugin?: boolean;
    target?: "both" | "channel" | "dm";
  };
  codexApproval?: boolean;
  messageTool?: boolean;
  progress?: {
    commentary?: boolean;
    toolProgress: boolean;
    verboseDefault?: "off" | "on" | "full";
  };
  replyToMode?: "all" | "off";
  users?: string[];
};

type SlackQaScenarioContext = {
  channelId: string;
  driverClient: WebClient;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  postSlackMessage: (params: { text: string; threadTs?: string }) => Promise<{ ts: string }>;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
  sutReadClient: WebClient;
  waitForReady: () => Promise<void>;
};

type SlackQaScenarioDefinition = LiveTransportScenarioDefinition<SlackQaScenarioId> & {
  buildRun: (sutUserId: string) => SlackQaScenarioRun;
  configOverrides?: SlackQaConfigOverrides;
  defaultEnabled?: boolean;
  forcedRuntime?: RuntimeId;
};

type SlackQaGatewayHarness = Awaited<ReturnType<typeof startQaLiveLaneGateway>>;

type SlackAuthIdentity = {
  botId?: string;
  teamId?: string;
  userId: string;
};

type SlackObservedMessage = {
  botId?: string;
  channelId: string;
  matchedScenario?: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
  text: string;
  actionValues?: string[];
  blockText?: string[];
  threadTs?: string;
  ts: string;
  userId?: string;
};

type SlackObservedMessageArtifact = {
  botId?: string;
  channelId?: string;
  matchedScenario?: boolean;
  scenarioId?: string;
  scenarioTitle?: string;
  text?: string;
  actionValues?: string[];
  blockText?: string[];
  threadTs?: string;
  ts?: string;
  userId?: string;
};

type SlackApprovalArtifact = {
  approvalId: string;
  approvalKind: SlackQaApprovalKind;
  appServerMethod?: SlackQaCodexApprovalMethod;
  channelId?: string;
  codexModelKey?: string;
  decision: SlackQaApprovalDecision;
  finalCodexTurnStatus?: string;
  operationVerified?: boolean;
  pendingActionValues?: string[];
  pendingCheckpointPath?: string;
  pendingMessageTs?: string;
  pendingScreenshotPath?: string;
  pendingText?: string;
  resolvedActionValues?: string[];
  resolvedCheckpointPath?: string;
  resolvedMessageTs?: string;
  resolvedScreenshotPath?: string;
  resolvedText?: string;
  threadTs?: string;
};

type SlackApprovalCheckpointState = "pending" | "resolved";

type SlackApprovalCheckpointAck = {
  capturedAt?: string;
  screenshotPath?: string;
};

type SlackApprovalCheckpointMessage = {
  actionLabels: string[];
  blockText: string[];
  hasNativeActions: boolean;
  text: string;
};

type SlackQaScenarioResult = {
  approval?: SlackApprovalArtifact;
  details: string;
  id: string;
  requestStartedAt?: string;
  responseObservedAt?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs: number;
    requestStartedAt: string;
    responseObservedAt: string;
    source: "approval-request-to-resolution" | "request-to-observed-message";
  };
  standardId?: string;
  status: "fail" | "pass";
  title: string;
};

type SlackQaRunResult = {
  gatewayDebugDirPath?: string;
  observedMessagesPath: string;
  outputDir: string;
  reportPath: string;
  scenarios: SlackQaScenarioResult[];
  summaryPath: string;
};

type SlackCredentialLease = Awaited<ReturnType<typeof acquireQaCredentialLease<SlackQaRuntimeEnv>>>;
type SlackCredentialHeartbeat = ReturnType<typeof startQaCredentialLeaseHeartbeat>;

const SLACK_QA_CAPTURE_CONTENT_ENV = "OPENCLAW_QA_SLACK_CAPTURE_CONTENT";
const SLACK_QA_APPROVAL_CHECKPOINT_DIR_ENV = "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR";
const SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV =
  "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS";
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";
const SLACK_QA_WEB_API_TIMEOUT_MS = 45_000;
const SLACK_QA_ENV_KEYS = [
  "OPENCLAW_QA_SLACK_CHANNEL_ID",
  "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_APP_TOKEN",
] as const;

const slackQaCredentialPayloadSchema = z.object({
  channelId: z.string().trim().min(1),
  driverBotToken: z.string().trim().min(1),
  sutBotToken: z.string().trim().min(1),
  sutAppToken: z.string().trim().min(1),
});

const slackAuthTestSchema = z.object({
  ok: z.boolean().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
  team_id: z.string().optional(),
});

const slackPostMessageSchema = z.object({
  ok: z.boolean().optional(),
  channel: z.string().optional(),
  ts: z.string().min(1),
});

const slackHistoryMessageSchema = z.object({
  bot_id: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string().min(1),
  user: z.string().optional(),
});

type SlackMessage = Omit<z.infer<typeof slackHistoryMessageSchema>, "ts"> & { ts?: string };

const slackHistorySchema = z.object({
  ok: z.boolean().optional(),
  messages: z.array(slackHistoryMessageSchema).optional(),
});

const slackRepliesSchema = z.object({
  ok: z.boolean().optional(),
  messages: z.array(slackHistoryMessageSchema).optional(),
});

function buildSlackChartMessageToolArgs(summaryText: string) {
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

function renderSlackChartAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    `${SLACK_QA_CHART_TITLE} (line chart)`,
    `X axis: ${SLACK_QA_CHART_X_LABEL}`,
    `Y axis: ${SLACK_QA_CHART_Y_LABEL}`,
    `- ${SLACK_QA_CHART_SERIES_NAME}: ${SLACK_QA_CHART_CATEGORIES[0]}: ${SLACK_QA_CHART_VALUES[0]}; ${SLACK_QA_CHART_CATEGORIES[1]}: ${SLACK_QA_CHART_VALUES[1]}`,
  ].join("\n");
}

function buildSlackTableMessageToolArgs(summaryText: string) {
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

function renderSlackTableAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    `${SLACK_QA_TABLE_CAPTION} (table)`,
    SLACK_QA_TABLE_HEADERS.join("\t"),
    ...SLACK_QA_TABLE_ROWS.map((row) => row.join("\t")),
  ].join("\n");
}

function buildSlackInvalidBlocksTableRow(index: number) {
  const rowId = String(index).padStart(3, "0");
  return [`row-${rowId}`, `value-${rowId}`] as const;
}

function buildSlackInvalidBlocksTableProbe() {
  const summaryText = `SLACK_QA_TABLE_INVALID_BLOCKS_${randomUUID().slice(0, 8).toUpperCase()}`;
  const dataRows = Array.from({ length: SLACK_QA_INVALID_TABLE_DATA_ROW_COUNT }, (_entry, index) =>
    buildSlackInvalidBlocksTableRow(index + 1),
  );
  const block = {
    type: "data_table",
    caption: SLACK_QA_INVALID_TABLE_CAPTION,
    rows: [
      SLACK_QA_INVALID_TABLE_HEADERS.map((text) => ({ type: "raw_text", text })),
      ...dataRows.map((row) => row.map((text) => ({ type: "raw_text", text }))),
    ],
    row_header_column_index: 0,
  } as const;
  const fallbackText = [
    summaryText,
    "",
    `${SLACK_QA_INVALID_TABLE_CAPTION} (table)`,
    SLACK_QA_INVALID_TABLE_HEADERS.join("\t"),
    ...dataRows.map((row) => row.join("\t")),
  ].join("\n");
  return {
    block,
    dataRowCount: dataRows.length,
    fallbackText,
    firstRowText: buildSlackInvalidBlocksTableRow(1).join("\t"),
    finalRowText: buildSlackInvalidBlocksTableRow(SLACK_QA_INVALID_TABLE_DATA_ROW_COUNT).join("\t"),
    summaryText,
  };
}

type SlackProgressCommentaryExpectation = {
  commentary: "absent" | "draft" | "standalone";
  toolProgress: "absent" | "draft" | "standalone";
};

function buildSlackProgressCommentaryRun(
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

const SLACK_QA_SCENARIOS: SlackQaScenarioDefinition[] = [
  {
    id: "slack-canary",
    standardId: "canary",
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
    standardId: "mention-gating",
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
    id: "slack-allowlist-block",
    standardId: "allowlist-block",
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
    defaultEnabled: false,
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
    standardId: "top-level-reply-shape",
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
    defaultEnabled: false,
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
    defaultEnabled: false,
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
    defaultEnabled: false,
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
    defaultEnabled: false,
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
    defaultEnabled: false,
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

const SLACK_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  scenarios: SLACK_QA_SCENARIOS,
});

export function listSlackQaScenarioCatalog() {
  return SLACK_QA_SCENARIOS.map((scenario) => ({ id: scenario.id }));
}

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof SLACK_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function normalizeSlackId(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a Slack id like C123 or U123.`);
  }
  return normalized;
}

function validateSlackQaRuntimeEnv(runtimeEnv: SlackQaRuntimeEnv, label: string) {
  normalizeSlackId(runtimeEnv.channelId, `${label} channelId`);
  return runtimeEnv;
}

function resolveSlackQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): SlackQaRuntimeEnv {
  const runtimeEnv = {
    channelId: resolveEnvValue(env, "OPENCLAW_QA_SLACK_CHANNEL_ID"),
    driverBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN"),
    sutBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN"),
    sutAppToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_APP_TOKEN"),
  };
  return validateSlackQaRuntimeEnv(runtimeEnv, "OPENCLAW_QA_SLACK");
}

function parseSlackQaCredentialPayload(payload: unknown): SlackQaRuntimeEnv {
  const parsed = slackQaCredentialPayloadSchema.parse(payload);
  const runtimeEnv = {
    channelId: parsed.channelId,
    driverBotToken: parsed.driverBotToken,
    sutBotToken: parsed.sutBotToken,
    sutAppToken: parsed.sutAppToken,
  };
  return validateSlackQaRuntimeEnv(runtimeEnv, "Slack credential payload");
}

function findScenario(ids?: string[]) {
  const selected = selectLiveTransportScenarios({
    ids,
    laneLabel: "Slack",
    scenarios: SLACK_QA_SCENARIOS,
  });
  return ids?.length ? selected : selected.filter((scenario) => scenario.defaultEnabled !== false);
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type SlackQaPostMessageAttempt = {
  failureCode?: string;
  formattingDisabled: boolean;
  nativeDataBlockCount: number;
  status: "failed" | "sent";
};

function countSlackNativeDataBlocks(value: unknown) {
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.filter((block) => {
    const type = asPlainRecord(block).type;
    return type === "data_table" || type === "data_visualization";
  }).length;
}

function readSlackApiFailureCode(error: unknown) {
  const record = asPlainRecord(error);
  const data = asPlainRecord(record.data);
  const code = data.error ?? record.error;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code) ? code : undefined;
}

function instrumentSlackPostMessage(client: WebClient) {
  const originalPostMessage = client.chat.postMessage;
  const attempts: SlackQaPostMessageAttempt[] = [];
  client.chat.postMessage = (async (payload) => {
    const payloadRecord = payload as { blocks?: unknown; mrkdwn?: boolean };
    const attempt = {
      formattingDisabled: payloadRecord.mrkdwn === false,
      nativeDataBlockCount: countSlackNativeDataBlocks(payloadRecord.blocks),
    };
    try {
      const response = await originalPostMessage.call(client.chat, payload);
      attempts.push({ ...attempt, status: "sent" });
      return response;
    } catch (error) {
      const failureCode = readSlackApiFailureCode(error);
      attempts.push({
        ...attempt,
        ...(failureCode ? { failureCode } : {}),
        status: "failed",
      });
      throw error;
    }
  }) as typeof client.chat.postMessage;
  return {
    attempts,
    restore: () => {
      client.chat.postMessage = originalPostMessage;
    },
  };
}

function buildSlackQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    channelId: string;
    driverBotUserId: string;
    overrides?: SlackQaConfigOverrides;
    primaryModel?: string;
    sutAccountId: string;
    sutAppToken: string;
    sutBotToken: string;
  },
): OpenClawConfig {
  const codexApprovalConfig = params.overrides?.codexApproval === true;
  const progressOverrides = params.overrides?.progress;
  const primaryModel = params.primaryModel;
  const pluginAllow = uniqueStrings([
    ...(baseCfg.plugins?.allow ?? []),
    "slack",
    ...(codexApprovalConfig ? ["codex"] : []),
  ]);
  const approvalOverrides = params.overrides?.approvals;
  const codexEntry = baseCfg.plugins?.entries?.codex;
  const codexEntryConfig = asPlainRecord(codexEntry?.config);
  const codexAppServerConfig = asPlainRecord(codexEntryConfig.appServer);
  const approvalForwardingConfig =
    approvalOverrides?.exec || approvalOverrides?.plugin
      ? {
          approvals: {
            ...baseCfg.approvals,
            ...(approvalOverrides.exec
              ? {
                  exec: {
                    ...baseCfg.approvals?.exec,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
            ...(approvalOverrides.plugin
              ? {
                  plugin: {
                    ...baseCfg.approvals?.plugin,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
          },
        }
      : {};
  const codexAgentDefaults =
    codexApprovalConfig && primaryModel
      ? {
          ...baseCfg.agents?.defaults,
          models: {
            ...baseCfg.agents?.defaults?.models,
            [primaryModel]: {
              ...baseCfg.agents?.defaults?.models?.[primaryModel],
              agentRuntime: { id: "codex" as const },
            },
          },
        }
      : baseCfg.agents?.defaults;
  const qaAgentDefaults = progressOverrides
    ? {
        ...codexAgentDefaults,
        ...(progressOverrides.verboseDefault
          ? { verboseDefault: progressOverrides.verboseDefault }
          : {}),
      }
    : codexAgentDefaults;
  const qaAgentList = progressOverrides
    ? baseCfg.agents?.list?.map((agent) => {
        if (agent.id !== "qa") {
          return agent;
        }
        // Slack draft edits cannot preserve custom authorship. Remove the
        // synthetic QA identity so progress scenarios reach the draft path.
        const qaAgent = { ...agent };
        delete qaAgent.identity;
        return qaAgent;
      })
    : baseCfg.agents?.list;
  const execApprovalsConfig = approvalOverrides
    ? {
        enabled: true,
        approvers: [params.driverBotUserId],
        target: approvalOverrides.target ?? ("channel" as const),
      }
    : undefined;
  const explicitToolAllow = baseCfg.tools?.allow;
  const messageToolPolicy = params.overrides?.messageTool
    ? explicitToolAllow && explicitToolAllow.length > 0
      ? { allow: uniqueStrings([...explicitToolAllow, "message"]) }
      : { alsoAllow: uniqueStrings([...(baseCfg.tools?.alsoAllow ?? []), "message"]) }
    : {};
  const toolsConfig =
    codexApprovalConfig || params.overrides?.messageTool
      ? {
          tools: {
            ...baseCfg.tools,
            ...messageToolPolicy,
            ...(codexApprovalConfig
              ? {
                  exec: {
                    ...baseCfg.tools?.exec,
                    mode: "ask" as const,
                  },
                }
              : {}),
          },
        }
      : {};
  return {
    ...baseCfg,
    ...approvalForwardingConfig,
    ...toolsConfig,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        slack: { enabled: true },
        ...(codexApprovalConfig
          ? {
              codex: {
                ...codexEntry,
                enabled: true,
                config: {
                  ...codexEntryConfig,
                  appServer: {
                    ...codexAppServerConfig,
                    mode: "guardian" as const,
                  },
                },
              },
            }
          : {}),
      },
    },
    ...(codexApprovalConfig || progressOverrides
      ? {
          agents: {
            ...baseCfg.agents,
            ...(qaAgentDefaults ? { defaults: qaAgentDefaults } : {}),
            ...(qaAgentList ? { list: qaAgentList } : {}),
          },
        }
      : {}),
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      slack: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            mode: "socket",
            botToken: params.sutBotToken,
            appToken: params.sutAppToken,
            allowFrom: params.overrides?.allowFrom ?? [params.driverBotUserId],
            groupPolicy: "allowlist",
            allowBots: true,
            replyToMode: params.overrides?.replyToMode ?? "off",
            ...(progressOverrides
              ? {
                  streaming: {
                    mode: "progress" as const,
                    progress: {
                      label: false,
                      maxLines: 4,
                      toolProgress: progressOverrides.toolProgress,
                      ...(progressOverrides.commentary === undefined
                        ? {}
                        : { commentary: progressOverrides.commentary }),
                    },
                  },
                }
              : {}),
            ...(execApprovalsConfig ? { execApprovals: execApprovalsConfig } : {}),
            channels: {
              [params.channelId]: {
                enabled: params.overrides?.channelEnabled ?? true,
                requireMention: true,
                allowBots: true,
                users: params.overrides?.users ?? [params.driverBotUserId],
              },
            },
          },
        },
      },
    },
  };
}

async function getSlackIdentity(token: string): Promise<SlackAuthIdentity> {
  const client = createSlackWebClient(token, { timeout: SLACK_QA_WEB_API_TIMEOUT_MS });
  const auth = slackAuthTestSchema.parse(await client.auth.test());
  if (!auth.user_id) {
    throw new Error("Slack auth.test did not return user_id.");
  }
  return {
    userId: auth.user_id,
    botId: auth.bot_id,
    teamId: auth.team_id,
  };
}

async function sendSlackChannelMessage(params: {
  channelId: string;
  client: WebClient;
  text: string;
  threadTs?: string;
}) {
  const postSlackMessage = params.client.chat.postMessage.bind(params.client.chat);
  const sent = slackPostMessageSchema.parse(
    await postSlackMessage({
      channel: params.channelId,
      text: params.text,
      thread_ts: params.threadTs,
      unfurl_links: false,
      unfurl_media: false,
    }),
  );
  return {
    channelId: sent.channel ?? params.channelId,
    ts: sent.ts,
  };
}

async function listSlackMessages(params: {
  channelId: string;
  client: WebClient;
  oldestTs: string;
}) {
  const history = slackHistorySchema.parse(
    await params.client.conversations.history({
      channel: params.channelId,
      inclusive: true,
      limit: 50,
      oldest: params.oldestTs,
    }),
  );
  return history.messages ?? [];
}

async function listSlackThreadMessages(params: {
  channelId: string;
  client: WebClient;
  threadTs: string;
}) {
  const replies = slackRepliesSchema.parse(
    await params.client.conversations.replies({
      channel: params.channelId,
      inclusive: true,
      limit: 50,
      ts: params.threadTs,
    }),
  );
  return replies.messages ?? [];
}

function collectSlackBlockStringFields(
  value: unknown,
  fieldName: string,
  values: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSlackBlockStringFields(entry, fieldName, values);
    }
    return values;
  }
  if (!value || typeof value !== "object") {
    return values;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === fieldName && typeof entry === "string" && entry.trim().length > 0) {
      values.push(entry);
      continue;
    }
    collectSlackBlockStringFields(entry, fieldName, values);
  }
  return values;
}

function collectSlackBlockText(blocks?: unknown[]) {
  return collectSlackBlockStringFields(blocks ?? [], "text");
}

function collectSlackActionValues(blocks?: unknown[]) {
  return collectSlackBlockStringFields(blocks ?? [], "value");
}

function parseSlackNativeApprovalAction(value: string) {
  if (!value.startsWith(SLACK_QA_APPROVAL_ACTION_PREFIX)) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(value.slice(SLACK_QA_APPROVAL_ACTION_PREFIX.length));
    const parsed = SlackQaApprovalActionValueSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function collectSlackButtonLabels(blocks?: unknown[]) {
  const labels: string[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.type === "button") {
      const text = candidate.text;
      if (text && typeof text === "object") {
        const label = (text as { text?: unknown }).text;
        if (typeof label === "string" && label.trim().length > 0) {
          labels.push(label);
        }
      }
    }
    for (const entry of Object.values(candidate)) {
      visit(entry);
    }
  }
  visit(blocks ?? []);
  return labels;
}

function buildSlackApprovalCheckpointMessage(
  message: SlackMessage,
): SlackApprovalCheckpointMessage {
  const actionValues = collectSlackActionValues(message.blocks);
  return {
    actionLabels: collectSlackButtonLabels(message.blocks),
    blockText: collectSlackBlockText(message.blocks),
    hasNativeActions: actionValues.some((value) => parseSlackNativeApprovalAction(value)),
    text: message.text ?? "",
  };
}

function hasSlackNativeApprovalActions(params: {
  actionValues: string[];
  approvalId?: string;
  decision: SlackQaApprovalDecision;
}) {
  return params.actionValues.some((value) => {
    const action = parseSlackNativeApprovalAction(value);
    return (
      action?.decision === params.decision &&
      (!params.approvalId || action.approvalId === params.approvalId)
    );
  });
}

function extractSlackNativeApprovalId(params: {
  actionValues: string[];
  decision: SlackQaApprovalDecision;
}) {
  for (const value of params.actionValues) {
    const action = parseSlackNativeApprovalAction(value);
    if (action?.decision === params.decision) {
      return action.approvalId;
    }
  }
  return undefined;
}

function isSutSlackMessage(message: SlackMessage, sutIdentity: SlackAuthIdentity) {
  return (
    (message.user !== undefined && message.user === sutIdentity.userId) ||
    (message.bot_id !== undefined && message.bot_id === sutIdentity.botId)
  );
}

// Slack history can flatten top-level accessibility newlines on readback.
// Normalize only whitespace; the native chart structure stays byte-for-byte strict below.
function normalizeSlackAccessibleText(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

function isExpectedSlackNativeChartMessage(message: SlackMessage, expectedAccessibleText: string) {
  if (
    normalizeSlackAccessibleText(message.text ?? "") !==
    normalizeSlackAccessibleText(expectedAccessibleText)
  ) {
    return false;
  }
  return (message.blocks ?? []).some((value) => {
    const block = asPlainRecord(value);
    return isDeepStrictEqual(
      { type: block.type, title: block.title, chart: block.chart },
      SLACK_QA_NATIVE_CHART,
    );
  });
}

async function waitForSlackStoredMessage(params: {
  channelId: string;
  client: WebClient;
  description: string;
  matchesMessage: (message: SlackMessage) => boolean;
  oldestTs: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (true) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.oldestTs,
    });
    const message = messages.find(
      (entry) =>
        entry.ts !== params.oldestTs &&
        isSutSlackMessage(entry, params.sutIdentity) &&
        params.matchesMessage(entry),
    );
    if (message) {
      return message;
    }
    const remainingMs = params.timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(1_000, remainingMs));
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Slack ${params.description}`);
}

function isExpectedSlackNativeTableMessage(message: SlackMessage, expectedAccessibleText: string) {
  if (
    normalizeSlackAccessibleText(message.text ?? "") !==
    normalizeSlackAccessibleText(expectedAccessibleText)
  ) {
    return false;
  }
  return (message.blocks ?? []).some((value) => {
    const block = asPlainRecord(value);
    return isDeepStrictEqual(
      {
        type: block.type,
        caption: block.caption,
        rows: block.rows,
        row_header_column_index: block.row_header_column_index,
      },
      SLACK_QA_NATIVE_TABLE,
    );
  });
}

async function runSlackTableInvalidBlocksFallbackScenario(
  context: SlackQaDirectTransportScenarioContext,
): Promise<SlackQaDirectTransportScenarioResult> {
  const probe = buildSlackInvalidBlocksTableProbe();
  const oldestTs = ((Date.now() - 5_000) / 1_000).toFixed(6);
  const instrumentation = instrumentSlackPostMessage(context.sutWriteClient);
  let sent: Awaited<ReturnType<typeof sendSlackMessage>>;
  try {
    try {
      sent = await sendSlackMessage(`channel:${context.channelId}`, probe.summaryText, {
        accountId: context.sutAccountId,
        blocks: [probe.block] as never,
        cfg: context.cfg,
        client: context.sutWriteClient,
        nativeDataFallbackBaseText: probe.summaryText,
      });
    } catch {
      const [nativeAttempt, fallbackAttempt] = instrumentation.attempts;
      if (nativeAttempt?.failureCode !== "invalid_blocks") {
        throw new Error(
          `expected first Slack API failure code invalid_blocks; observed ${nativeAttempt?.failureCode ?? "none"}`,
        );
      }
      throw new Error(
        `Slack fallback failed after invalid_blocks; observed ${fallbackAttempt?.failureCode ?? "no fallback API failure code"}`,
      );
    }
  } finally {
    instrumentation.restore();
  }

  const [nativeAttempt, fallbackAttempt] = instrumentation.attempts;
  if (instrumentation.attempts.length !== 2) {
    throw new Error(
      `expected exactly two Slack API attempts; observed ${instrumentation.attempts.length}`,
    );
  }
  if (
    nativeAttempt?.status !== "failed" ||
    nativeAttempt.failureCode !== "invalid_blocks" ||
    nativeAttempt.nativeDataBlockCount !== 1
  ) {
    throw new Error(
      `expected first Slack API attempt to fail with invalid_blocks for one native data block; observed ${nativeAttempt?.failureCode ?? "none"}`,
    );
  }
  if (
    fallbackAttempt?.status !== "sent" ||
    fallbackAttempt.nativeDataBlockCount !== 0 ||
    !fallbackAttempt.formattingDisabled
  ) {
    throw new Error("Slack fallback did not use one formatting-disabled blockless API request");
  }

  const message = await waitForSlackStoredMessage({
    channelId: context.channelId,
    client: context.sutReadClient,
    description: "stored invalid_blocks fallback message",
    matchesMessage: (candidate) => candidate.ts === sent.messageId,
    oldestTs,
    sutIdentity: context.sutIdentity,
    timeoutMs: context.timeoutMs,
  });
  const storedText = message.text ?? "";
  if (countSlackNativeDataBlocks(message.blocks) !== 0) {
    throw new Error("stored Slack fallback retained a native data block");
  }
  const storedLines = storedText.split("\n");
  if (!storedLines.includes(probe.firstRowText)) {
    throw new Error("stored Slack fallback omitted the exact first data row");
  }
  if (!storedLines.includes(probe.finalRowText)) {
    throw new Error("stored Slack fallback omitted the exact final data row");
  }
  if (storedText !== probe.fallbackText) {
    throw new Error(
      `stored Slack fallback was incomplete: expected ${probe.fallbackText.length} characters, observed ${storedText.length}`,
    );
  }
  return {
    details: [
      "direct transport",
      "first API failure=invalid_blocks",
      "API attempts=2",
      `data rows=${probe.dataRowCount}`,
      "fallback formatting disabled=true",
      "stored native data blocks=0",
      "first row=present",
      "final row=present",
      "complete delivery=true",
    ].join("; "),
    message,
  };
}

type SlackScenarioObservationContext = {
  channelId: string;
  matchText: string;
  observedMessages: SlackObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
};

function recordSlackScenarioMessages(
  params: SlackScenarioObservationContext & { messages: SlackMessage[] },
) {
  let matchedMessage: SlackMessage | undefined;
  for (const message of params.messages) {
    const text = message.text ?? "";
    if (
      !message.ts ||
      message.ts === params.sentTs ||
      !isSutSlackMessage(message, params.sutIdentity)
    ) {
      continue;
    }
    const matchedScenario = text.includes(params.matchText);
    params.observedMessages.push({
      actionValues: collectSlackActionValues(message.blocks),
      blockText: collectSlackBlockText(message.blocks),
      botId: message.bot_id,
      channelId: params.channelId,
      matchedScenario,
      scenarioId: params.observationScenarioId,
      scenarioTitle: params.observationScenarioTitle,
      text,
      threadTs: message.thread_ts,
      ts: message.ts,
      userId: message.user,
    });
    if (matchedScenario && !matchedMessage) {
      matchedMessage = message;
    }
  }
  return matchedMessage;
}

async function waitForSlackScenarioReply(
  params: SlackScenarioObservationContext & {
    client: WebClient;
    threadTs?: string;
    timeoutMs: number;
  },
) {
  const observationContext: SlackScenarioObservationContext = params;
  const startedAt = Date.now();
  const inspectMessages = (messages: SlackMessage[]) => {
    const matchedMessage = recordSlackScenarioMessages({ ...observationContext, messages });
    return matchedMessage
      ? { message: matchedMessage, observedAt: new Date().toISOString() }
      : undefined;
  };

  while (Date.now() - startedAt < params.timeoutMs) {
    const channelMessages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.sentTs,
    });
    const channelReply = inspectMessages(channelMessages);
    if (channelReply) {
      return channelReply;
    }

    try {
      const threadMessages = await listSlackThreadMessages({
        channelId: params.channelId,
        client: params.client,
        threadTs: params.threadTs ?? params.sentTs,
      });
      const threadReply = inspectMessages(threadMessages);
      if (threadReply) {
        return threadReply;
      }
    } catch (error) {
      throw new Error(
        `Slack conversations.replies failed while waiting for ${params.observationScenarioId}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Slack message`);
}

async function observeSlackScenarioMessages(
  params: SlackScenarioObservationContext & {
    client: WebClient;
    settleMs: number;
    threadTs?: string;
  },
) {
  const observationContext: SlackScenarioObservationContext = params;
  const startedAt = Date.now();

  while (true) {
    recordSlackScenarioMessages({
      ...observationContext,
      messages: await listSlackMessages({
        channelId: params.channelId,
        client: params.client,
        oldestTs: params.sentTs,
      }),
    });
    try {
      recordSlackScenarioMessages({
        ...observationContext,
        messages: await listSlackThreadMessages({
          channelId: params.channelId,
          client: params.client,
          threadTs: params.threadTs ?? params.sentTs,
        }),
      });
    } catch (error) {
      throw new Error(
        `Slack conversations.replies failed while settling ${params.observationScenarioId}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    const remainingMs = params.settleMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(1_000, remainingMs));
    });
  }
}

async function waitForSlackNoReply(params: {
  channelId: string;
  client: WebClient;
  matchText: string;
  observedMessages: SlackObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  const observedKeys = new Set(
    params.observedMessages
      .map((message) => `${message.channelId ?? params.channelId}:${message.ts ?? ""}`)
      .filter((key) => !key.endsWith(":")),
  );
  let elapsedMs = Date.now() - startedAt;
  while (elapsedMs < params.timeoutMs) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.sentTs,
    });
    for (const message of messages) {
      const text = message.text ?? "";
      if (
        !message.ts ||
        message.ts === params.sentTs ||
        !isSutSlackMessage(message, params.sutIdentity)
      ) {
        continue;
      }
      const matchedScenario = text.includes(params.matchText);
      const observedKey = `${params.channelId}:${message.ts}`;
      if (!observedKeys.has(observedKey)) {
        observedKeys.add(observedKey);
        params.observedMessages.push({
          actionValues: collectSlackActionValues(message.blocks),
          blockText: collectSlackBlockText(message.blocks),
          botId: message.bot_id,
          channelId: params.channelId,
          matchedScenario,
          scenarioId: params.observationScenarioId,
          scenarioTitle: params.observationScenarioTitle,
          text,
          threadTs: message.thread_ts,
          ts: message.ts,
          userId: message.user,
        });
      }
      if (matchedScenario) {
        throw new Error("unexpected Slack SUT reply observed");
      }
    }
    elapsedMs = Date.now() - startedAt;
    const remainingMs = params.timeoutMs - elapsedMs;
    if (remainingMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(1_000, remainingMs));
      });
    }
    elapsedMs = Date.now() - startedAt;
  }
}

function resolveApprovalDecisionLabel(decision: SlackQaApprovalDecision) {
  return decision === "allow-once"
    ? "Allowed once"
    : decision === "allow-always"
      ? "Allowed always"
      : "Denied";
}

function resolveApprovalHeading(params: {
  approvalKind: SlackQaApprovalKind;
  state: "pending" | "resolved";
  decision?: SlackQaApprovalDecision;
}) {
  if (params.state === "pending") {
    return params.approvalKind === "exec" ? "Exec approval required" : "Plugin approval required";
  }
  const label = resolveApprovalDecisionLabel(params.decision ?? "allow-once");
  return params.approvalKind === "exec" ? `Exec approval: ${label}` : `Plugin approval: ${label}`;
}

function getSlackMessageSearchText(message: SlackMessage) {
  return [message.text ?? "", ...collectSlackBlockText(message.blocks)].join("\n");
}

function pushObservedApprovalMessage(params: {
  channelId: string;
  matchedScenario: boolean;
  message: SlackMessage;
  observedMessages: SlackObservedMessage[];
  scenarioId: string;
  scenarioTitle: string;
}) {
  if (!params.message.ts) {
    return;
  }
  params.observedMessages.push({
    actionValues: collectSlackActionValues(params.message.blocks),
    blockText: collectSlackBlockText(params.message.blocks),
    botId: params.message.bot_id,
    channelId: params.channelId,
    matchedScenario: params.matchedScenario,
    scenarioId: params.scenarioId,
    scenarioTitle: params.scenarioTitle,
    text: params.message.text ?? "",
    threadTs: params.message.thread_ts,
    ts: params.message.ts,
    userId: params.message.user,
  });
}

async function waitForSlackApprovalPrompt(params: {
  approvalId?: string;
  approvalKind: SlackQaApprovalKind;
  channelId: string;
  client: WebClient;
  decision: SlackQaApprovalDecision;
  observedMessages: SlackObservedMessage[];
  oldestTs: string;
  scenarioId: string;
  scenarioTitle: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
  token?: string;
  extraTextMatches?: string[];
}) {
  const startedAt = Date.now();
  const seenObservedMessages = new Set<string>();
  let lastMatchedWithoutActions = "";
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.oldestTs,
    });
    for (const message of messages) {
      if (!message.ts || !isSutSlackMessage(message, params.sutIdentity)) {
        continue;
      }
      const text = getSlackMessageSearchText(message);
      const actionValues = collectSlackActionValues(message.blocks);
      const matchedScenario = matchesSlackApprovalPromptText({
        approvalKind: params.approvalKind,
        extraTextMatches: params.extraTextMatches,
        text,
        token: params.token,
      });
      const observedKey = `${message.ts}:${message.text ?? ""}:${actionValues.join("|")}`;
      if (matchedScenario || hasSlackNativeApprovalActions({ ...params, actionValues })) {
        if (!seenObservedMessages.has(observedKey)) {
          seenObservedMessages.add(observedKey);
          pushObservedApprovalMessage({
            channelId: params.channelId,
            matchedScenario,
            message,
            observedMessages: params.observedMessages,
            scenarioId: params.scenarioId,
            scenarioTitle: params.scenarioTitle,
          });
        }
      }
      if (!matchedScenario) {
        continue;
      }
      if (
        !hasSlackNativeApprovalActions({
          actionValues,
          approvalId: params.approvalId,
          decision: params.decision,
        })
      ) {
        lastMatchedWithoutActions = `message ${message.ts} matched approval text but did not expose native approval button values`;
        continue;
      }
      return {
        actionValues,
        approvalId:
          params.approvalId ??
          extractSlackNativeApprovalId({
            actionValues,
            decision: params.decision,
          }),
        message,
        observedAt: new Date().toISOString(),
      };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(
    [
      `timed out after ${params.timeoutMs}ms waiting for Slack ${params.approvalKind} approval prompt`,
      lastMatchedWithoutActions,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

function matchesSlackApprovalPromptText(params: {
  approvalKind: SlackQaApprovalKind;
  extraTextMatches?: string[];
  text: string;
  token?: string;
}) {
  return (
    params.text.includes(
      resolveApprovalHeading({ approvalKind: params.approvalKind, state: "pending" }),
    ) &&
    (!params.token || params.text.includes(params.token)) &&
    (params.extraTextMatches ?? []).every((match) => params.text.includes(match))
  );
}

async function waitForSlackApprovalResolvedUpdate(params: {
  approvalKind: SlackQaApprovalKind;
  channelId: string;
  client: WebClient;
  decision: SlackQaApprovalDecision;
  messageTs: string;
  observedMessages: SlackObservedMessage[];
  oldestTs: string;
  scenarioId: string;
  scenarioTitle: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
  token?: string;
  extraTextMatches?: string[];
}) {
  const startedAt = Date.now();
  const seenObservedMessages = new Set<string>();
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.oldestTs,
    });
    const message = messages.find((entry) => entry.ts === params.messageTs);
    if (message && isSutSlackMessage(message, params.sutIdentity)) {
      const text = getSlackMessageSearchText(message);
      const actionValues = collectSlackActionValues(message.blocks);
      const matchedScenario = matchesSlackApprovalResolvedUpdate({
        actionValues,
        approvalKind: params.approvalKind,
        decision: params.decision,
        extraTextMatches: params.extraTextMatches,
        text,
        token: params.token,
      });
      const observedKey = `${message.ts}:${message.text ?? ""}:${actionValues.join("|")}`;
      if (!seenObservedMessages.has(observedKey)) {
        seenObservedMessages.add(observedKey);
        pushObservedApprovalMessage({
          channelId: params.channelId,
          matchedScenario,
          message,
          observedMessages: params.observedMessages,
          scenarioId: params.scenarioId,
          scenarioTitle: params.scenarioTitle,
        });
      }
      if (matchedScenario) {
        return {
          actionValues,
          message,
          observedAt: new Date().toISOString(),
        };
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(
    `timed out after ${params.timeoutMs}ms waiting for Slack ${params.approvalKind} approval resolution update`,
  );
}

function matchesSlackApprovalResolvedUpdate(params: {
  actionValues: string[];
  approvalKind: SlackQaApprovalKind;
  decision: SlackQaApprovalDecision;
  extraTextMatches?: string[];
  text: string;
  token?: string;
}) {
  return (
    params.text.includes(
      resolveApprovalHeading({
        approvalKind: params.approvalKind,
        decision: params.decision,
        state: "resolved",
      }),
    ) &&
    (!params.token || params.text.includes(params.token)) &&
    (params.extraTextMatches ?? []).every((match) => params.text.includes(match)) &&
    !params.actionValues.some((value) => parseSlackNativeApprovalAction(value))
  );
}

function resolveSlackApprovalCheckpointConfig(env: NodeJS.ProcessEnv = process.env) {
  const checkpointDir = env[SLACK_QA_APPROVAL_CHECKPOINT_DIR_ENV]?.trim();
  if (!checkpointDir) {
    return undefined;
  }
  const rawTimeout = env[SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV]?.trim();
  const timeoutMs = rawTimeout
    ? parseStrictPositiveInteger(rawTimeout)
    : SLACK_QA_APPROVAL_CHECKPOINT_DEFAULT_TIMEOUT_MS;
  if (timeoutMs === undefined) {
    throw new Error(`${SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV} must be a positive integer.`);
  }
  return {
    checkpointDir,
    timeoutMs,
  };
}

async function waitForSlackApprovalCheckpointAck(params: {
  ackPath: string;
  timeoutMs: number;
}): Promise<SlackApprovalCheckpointAck> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const parsed = JSON.parse(await fs.readFile(params.ackPath, "utf8")) as {
        capturedAt?: unknown;
        error?: unknown;
        screenshotPath?: unknown;
      };
      if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
        throw new Error(`Slack approval checkpoint watcher failed: ${parsed.error}`);
      }
      return {
        capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : undefined,
        screenshotPath:
          typeof parsed.screenshotPath === "string" ? parsed.screenshotPath : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for ${params.ackPath}`);
}

async function writeSlackApprovalCheckpoint(params: {
  approvalId: string;
  approvalKind: SlackQaApprovalKind;
  channelId: string;
  decision?: SlackQaApprovalDecision;
  message: SlackMessage;
  observedAt: string;
  scenarioId: SlackQaScenarioId;
  state: SlackApprovalCheckpointState;
}) {
  const config = resolveSlackApprovalCheckpointConfig();
  if (!config) {
    return undefined;
  }
  await fs.mkdir(config.checkpointDir, { recursive: true });
  const checkpointPath = path.join(
    config.checkpointDir,
    `${params.scenarioId}.${params.state}.json`,
  );
  const ackPath = path.join(config.checkpointDir, `${params.scenarioId}.${params.state}.ack.json`);
  await fs.rm(ackPath, { force: true }).catch(() => {});
  await fs.writeFile(
    checkpointPath,
    `${JSON.stringify(
      {
        version: 1,
        scenarioId: params.scenarioId,
        approvalKind: params.approvalKind,
        state: params.state,
        approvalId: params.approvalId,
        channelId: params.channelId,
        messageTs: params.message.ts,
        threadTs: params.message.thread_ts ?? null,
        decision: params.decision ?? null,
        observedAt: params.observedAt,
        message: buildSlackApprovalCheckpointMessage(params.message),
      },
      null,
      2,
    )}\n`,
  );
  const ack = await waitForSlackApprovalCheckpointAck({
    ackPath,
    timeoutMs: config.timeoutMs,
  });
  return {
    ackPath,
    checkpointPath,
    screenshotPath: ack.screenshotPath,
  };
}

async function requestSlackApproval(params: {
  approvalId: string;
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  run: SlackQaApprovalScenarioRun;
  sutAccountId: string;
}) {
  const commonParams = {
    timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
    turnSourceAccountId: params.sutAccountId,
    turnSourceChannel: "slack",
    turnSourceTo: `channel:${params.channelId}`,
    twoPhase: true,
  };
  if (params.run.approvalKind === "exec") {
    const result = await params.context.gateway.call(
      "exec.approval.request",
      {
        ...commonParams,
        ask: "always",
        command: `printf '%s\\n' '${params.run.token}'`,
        host: "gateway",
        id: params.approvalId,
        security: "full",
      },
      {
        expectFinal: false,
        timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
      },
    );
    const acceptedId = readAcceptedApprovalRequestId(result);
    if (acceptedId !== params.approvalId) {
      throw new Error(
        `accepted exec approval id was ${formatApprovalResultValue(
          acceptedId,
        )} instead of ${params.approvalId}`,
      );
    }
    return acceptedId;
  }
  const result = await params.context.gateway.call(
    "plugin.approval.request",
    {
      ...commonParams,
      agentId: "qa",
      description: `Slack plugin approval QA request ${params.run.token}`,
      pluginId: "qa-slack-plugin",
      severity: "warning",
      title: `Slack plugin approval QA ${params.run.token}`,
      toolName: "slack_qa_tool",
    },
    {
      expectFinal: false,
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
  return readAcceptedApprovalRequestId(result);
}

async function waitForApprovalDecision(params: {
  approvalId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  kind: SlackQaApprovalKind;
}) {
  const method =
    params.kind === "exec" ? "exec.approval.waitDecision" : "plugin.approval.waitDecision";
  return await params.context.gateway.call(
    method,
    { id: params.approvalId },
    {
      expectFinal: true,
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

async function resolveApprovalDecision(params: {
  approvalId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  decision: SlackQaApprovalDecision;
  kind: SlackQaApprovalKind;
}) {
  const method = params.kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve";
  return await params.context.gateway.call(
    method,
    { decision: params.decision, id: params.approvalId },
    {
      expectFinal: false,
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

async function runSlackApprovalScenario(params: {
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  observedMessages: SlackObservedMessage[];
  run: SlackQaApprovalScenarioRun;
  scenario: SlackQaScenarioDefinition;
  sutAccountId: string;
}) {
  const requestStartedAt = new Date();
  const oldestTs = ((requestStartedAt.getTime() - 5_000) / 1_000).toFixed(6);
  const requestedApprovalId =
    params.run.approvalKind === "exec"
      ? `slack-qa-exec-${randomUUID()}`
      : `slack-qa-plugin-${randomUUID()}`;
  const approvalId = await requestSlackApproval({
    approvalId: requestedApprovalId,
    channelId: params.channelId,
    context: params.context,
    run: params.run,
    sutAccountId: params.sutAccountId,
  });
  const pending = await waitForSlackApprovalPrompt({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
  });
  const pendingCheckpoint = await writeSlackApprovalCheckpoint({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    message: pending.message,
    observedAt: pending.observedAt,
    scenarioId: params.scenario.id,
    state: "pending",
  });
  await resolveApprovalDecision({
    approvalId,
    context: params.context,
    decision: params.run.decision,
    kind: params.run.approvalKind,
  });
  assertApprovalDecisionResult({
    decision: params.run.decision,
    result: await waitForApprovalDecision({
      approvalId,
      context: params.context,
      kind: params.run.approvalKind,
    }),
  });
  const resolved = await waitForSlackApprovalResolvedUpdate({
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    messageTs: pending.message.ts,
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
  });
  const resolvedCheckpoint = await writeSlackApprovalCheckpoint({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    decision: params.run.decision,
    message: resolved.message,
    observedAt: resolved.observedAt,
    scenarioId: params.scenario.id,
    state: "resolved",
  });
  const responseObservedAt = new Date(resolved.observedAt);
  return {
    artifact: {
      approvalId,
      approvalKind: params.run.approvalKind,
      channelId: params.channelId,
      decision: params.run.decision,
      pendingActionValues: pending.actionValues,
      pendingCheckpointPath: pendingCheckpoint?.checkpointPath,
      pendingMessageTs: pending.message.ts,
      pendingScreenshotPath: pendingCheckpoint?.screenshotPath,
      pendingText: pending.message.text,
      resolvedActionValues: resolved.actionValues,
      resolvedCheckpointPath: resolvedCheckpoint?.checkpointPath,
      resolvedMessageTs: resolved.message.ts,
      resolvedScreenshotPath: resolvedCheckpoint?.screenshotPath,
      resolvedText: resolved.message.text,
      threadTs: pending.message.thread_ts,
    } satisfies SlackApprovalArtifact,
    requestStartedAt,
    responseObservedAt,
    rttMs: responseObservedAt.getTime() - requestStartedAt.getTime(),
  };
}

function buildCodexApprovalInstruction(params: {
  appServerMethod: SlackQaCodexApprovalMethod;
  token: string;
}) {
  if (params.appServerMethod === "item/commandExecution/requestApproval") {
    return [
      "Slack QA Codex command approval scenario.",
      `Marker: ${params.token}`,
      "Use the shell tool exactly once and request approval before running it.",
      `Run exactly: printf '${params.token}\\n'`,
      `After the command succeeds, reply exactly ${params.token} and nothing else.`,
    ].join("\n");
  }
  const targetPath = resolveCodexFileApprovalTargetPath(params.token);
  return [
    "Slack QA Codex file approval scenario.",
    `Marker: ${params.token}`,
    "Use apply_patch exactly once to create this file outside the workspace.",
    `Target file: ${targetPath}`,
    `File contents: ${params.token}`,
    "Invoke apply_patch now. Do not ask for approval in chat; the harness will resolve the native tool approval.",
    `After the file change succeeds, reply exactly ${params.token} and nothing else.`,
  ].join("\n");
}

function readAcceptedAgentRunId(result: unknown) {
  const started =
    typeof result === "object" && result !== null
      ? (result as { runId?: unknown; status?: unknown })
      : null;
  if (started?.status !== "accepted") {
    throw new Error(
      `Codex agent run status was ${formatApprovalResultValue(started?.status)} instead of accepted`,
    );
  }
  if (typeof started.runId !== "string" || started.runId.trim().length === 0) {
    throw new Error(`Codex agent run id was ${formatApprovalResultValue(started.runId)}`);
  }
  return started.runId;
}

function readAgentWaitStatus(result: unknown) {
  if (typeof result !== "object" || result === null) {
    return "unknown";
  }
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" && status.trim() ? status : "unknown";
}

async function waitForSlackReaction(params: {
  channelId: string;
  client: WebClient;
  expectedReactionName: string;
  messageId: string;
  sutUserId: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (true) {
    const reactions = await listSlackReactions(params.channelId, params.messageId, {
      client: params.client,
    });
    const reaction = reactions?.find(
      (entry) =>
        entry.name === params.expectedReactionName && entry.users?.includes(params.sutUserId),
    );
    if (reaction) {
      return reaction;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(
    `Slack message ${params.messageId} did not receive ${params.expectedReactionName} from ${params.sutUserId}`,
  );
}

function assertCodexApprovalTranscriptSucceeded(
  messages: unknown,
  run: SlackQaCodexApprovalScenarioRun,
) {
  const records = Array.isArray(messages) ? messages.map(asPlainRecord) : [];
  const assistantReply = records
    .toReversed()
    .find((message) => message.role === "assistant" && extractGatewayMessageText(message));
  if (!assistantReply || extractGatewayMessageText(assistantReply) !== run.token) {
    throw new Error(`Codex approval run did not finish with assistant marker ${run.token}`);
  }
  if (run.appServerMethod !== "item/commandExecution/requestApproval") {
    return;
  }
  const commandSucceeded = records.some((message) => {
    if (message.role !== "toolResult" || message.isError === true) {
      return false;
    }
    return extractGatewayMessageText(message)
      .split(/\r?\n/u)
      .some((line) => line.trim() === run.token);
  });
  if (!commandSucceeded) {
    throw new Error(`Codex command result did not contain marker ${run.token}`);
  }
}

async function assertCodexApprovalOperationSucceeded(params: {
  context: Omit<SlackQaScenarioContext, "sentTs">;
  run: SlackQaCodexApprovalScenarioRun;
  sessionKey: string;
}) {
  const history = asPlainRecord(
    await params.context.gateway.call(
      "chat.history",
      { sessionKey: params.sessionKey, limit: 24 },
      { timeoutMs: 10_000 },
    ),
  );
  assertCodexApprovalTranscriptSucceeded(history.messages, params.run);
  if (params.run.appServerMethod !== "item/fileChange/requestApproval") {
    return;
  }
  const targetPath = resolveCodexFileApprovalTargetPath(params.run.token);
  const contents = await fs.readFile(targetPath, "utf8");
  if (contents.trim() !== params.run.token) {
    throw new Error(`Codex file result at ${targetPath} did not contain the expected marker`);
  }
}

function findPendingCodexPluginApprovalRecord(params: {
  approvalId: string;
  appServerMethod: SlackQaCodexApprovalMethod;
  channelId: string;
  records: unknown;
  sessionKey: string;
  sutAccountId: string;
}) {
  const list = Array.isArray(params.records) ? params.records : [];
  const expectedTitle =
    params.appServerMethod === "item/commandExecution/requestApproval"
      ? "Codex app-server command approval"
      : "Codex app-server file approval";
  const expectedToolName =
    params.appServerMethod === "item/commandExecution/requestApproval"
      ? "codex_command_approval"
      : "codex_file_approval";
  for (const entry of list) {
    const record = asPlainRecord(entry);
    if (record.id !== params.approvalId) {
      continue;
    }
    const request = asPlainRecord(record.request);
    if (
      request.pluginId === "openclaw-codex-app-server" &&
      request.title === expectedTitle &&
      request.toolName === expectedToolName &&
      request.sessionKey === params.sessionKey &&
      request.turnSourceChannel === "slack" &&
      request.turnSourceTo === `channel:${params.channelId}` &&
      request.turnSourceAccountId === params.sutAccountId
    ) {
      return record;
    }
  }
  return undefined;
}

async function assertPendingCodexPluginApproval(params: {
  approvalId: string;
  appServerMethod: SlackQaCodexApprovalMethod;
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  sessionKey: string;
  sutAccountId: string;
}) {
  const records = await params.context.gateway.call(
    "plugin.approval.list",
    {},
    {
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
    },
  );
  const record = findPendingCodexPluginApprovalRecord({
    approvalId: params.approvalId,
    appServerMethod: params.appServerMethod,
    channelId: params.channelId,
    records,
    sessionKey: params.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  if (!record) {
    throw new Error(
      `Pending Codex plugin approval ${params.approvalId} did not match the expected app-server route and Slack turn source.`,
    );
  }
}

async function startCodexApprovalAgentRun(params: {
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  runId: string;
  scenario: SlackQaScenarioDefinition;
  sessionKey: string;
  sutAccountId: string;
}) {
  const result = await params.context.gateway.call(
    "agent",
    {
      accountId: params.sutAccountId,
      agentId: "qa",
      channel: "slack",
      cleanupBundleMcpOnRunEnd: true,
      deliver: false,
      idempotencyKey: params.runId,
      message: buildCodexApprovalInstruction({
        appServerMethod: params.run.appServerMethod,
        token: params.run.token,
      }),
      model: params.primaryModel,
      sessionKey: params.sessionKey,
      thinking: "low",
      timeout: Math.ceil(params.scenario.timeoutMs / 1_000),
      to: `channel:${params.channelId}`,
    },
    {
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
  const acceptedRunId = readAcceptedAgentRunId(result);
  if (acceptedRunId !== params.runId) {
    throw new Error(`Codex agent run id was ${acceptedRunId} instead of ${params.runId}`);
  }
}

function buildCodexApprovalSessionKey(params: {
  scenario: SlackQaScenarioDefinition;
  token: string;
}) {
  return `agent:qa:${params.scenario.id}-${params.token.toLowerCase()}`;
}

async function waitForCodexApprovalAgentRun(params: {
  context: Omit<SlackQaScenarioContext, "sentTs">;
  runId: string;
  timeoutMs: number;
}) {
  const result = await params.context.gateway.call(
    "agent.wait",
    {
      runId: params.runId,
      timeoutMs: params.timeoutMs,
    },
    {
      timeoutMs: params.timeoutMs + 5_000,
    },
  );
  return readAgentWaitStatus(result);
}

async function quiesceCodexApprovalAgentRun(params: {
  context: Omit<SlackQaScenarioContext, "sentTs">;
  preserveDebugArtifacts: boolean;
  runId: string;
  sessionKey: string;
  stopGateway: (preserveDebugArtifacts: boolean) => Promise<void>;
}) {
  try {
    await params.context.gateway.call(
      "chat.abort",
      { runId: params.runId, sessionKey: params.sessionKey },
      { timeoutMs: 10_000 },
    );
  } catch {
    // The bounded terminal wait and gateway process-group teardown do not depend on this ack.
  }
  try {
    await params.context.gateway.call(
      "agent.wait",
      { runId: params.runId, timeoutMs: 10_000 },
      { timeoutMs: 15_000 },
    );
  } catch {
    // QA-owned Codex app-server processes inherit the gateway cleanup process group.
  }
  await params.stopGateway(params.preserveDebugArtifacts);
}

async function runSlackCodexApprovalScenario(params: {
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  observedMessages: SlackObservedMessage[];
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  scenario: SlackQaScenarioDefinition;
  stopGateway: (preserveDebugArtifacts: boolean) => Promise<void>;
  sutAccountId: string;
}) {
  const codexRun = {
    runId: `slack-qa-codex-approval-${randomUUID()}`,
    sessionKey: buildCodexApprovalSessionKey({
      scenario: params.scenario,
      token: params.run.token,
    }),
  };
  const targetPath =
    params.run.appServerMethod === "item/fileChange/requestApproval"
      ? resolveCodexFileApprovalTargetPath(params.run.token)
      : undefined;
  if (targetPath) {
    await fs.rm(targetPath, { force: true });
  }
  const outcome = await runSlackCodexApprovalScenarioInner({ ...params, codexRun }).then(
    (result) => ({ kind: "success", result }) as const,
    (error: unknown) => ({ error, kind: "failure" }) as const,
  );
  // Kill the gateway process tree before deleting the probe. Agent completion
  // does not prove the native Codex turn has stopped writing after an interrupt.
  const cleanupErrors: unknown[] = [];
  try {
    await quiesceCodexApprovalAgentRun({
      context: params.context,
      preserveDebugArtifacts: outcome.kind === "failure",
      stopGateway: params.stopGateway,
      ...codexRun,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 0 && targetPath) {
    try {
      await fs.rm(targetPath, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    const cleanupSummary = cleanupErrors.map(formatErrorMessage).join("; ");
    if (outcome.kind === "failure") {
      throw new AggregateError(
        [outcome.error, ...cleanupErrors],
        `Codex approval scenario failed: ${formatErrorMessage(outcome.error)}; cleanup also failed: ${cleanupSummary}`,
        { cause: outcome.error },
      );
    }
    throw new AggregateError(cleanupErrors, `Codex approval cleanup failed: ${cleanupSummary}`);
  }
  if (outcome.kind === "failure") {
    throw outcome.error;
  }
  return outcome.result;
}

function resolveCodexFileApprovalTargetPath(token: string) {
  return path.join(os.homedir(), `.openclaw-qa-codex-file-approval-${token.toLowerCase()}.txt`);
}

async function runSlackCodexApprovalScenarioInner(params: {
  channelId: string;
  codexRun: { runId: string; sessionKey: string };
  context: Omit<SlackQaScenarioContext, "sentTs">;
  observedMessages: SlackObservedMessage[];
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  scenario: SlackQaScenarioDefinition;
  sutAccountId: string;
}) {
  const requestStartedAt = new Date();
  const oldestTs = ((requestStartedAt.getTime() - 5_000) / 1_000).toFixed(6);
  await startCodexApprovalAgentRun({
    channelId: params.channelId,
    context: params.context,
    primaryModel: params.primaryModel,
    run: params.run,
    runId: params.codexRun.runId,
    scenario: params.scenario,
    sessionKey: params.codexRun.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  const expectedTitle =
    params.run.appServerMethod === "item/commandExecution/requestApproval"
      ? "Codex app-server command approval"
      : "Codex app-server file approval";
  const pending = await waitForSlackApprovalPrompt({
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    extraTextMatches: ["openclaw-codex-app-server", expectedTitle],
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
  });
  const approvalId = pending.approvalId;
  if (!approvalId) {
    throw new Error(
      "Codex Slack approval prompt exposed native actions but no plugin approval id.",
    );
  }
  await assertPendingCodexPluginApproval({
    approvalId,
    appServerMethod: params.run.appServerMethod,
    channelId: params.channelId,
    context: params.context,
    sessionKey: params.codexRun.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  const pendingCheckpoint = await writeSlackApprovalCheckpoint({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    message: pending.message,
    observedAt: pending.observedAt,
    scenarioId: params.scenario.id,
    state: "pending",
  });
  await resolveApprovalDecision({
    approvalId,
    context: params.context,
    decision: params.run.decision,
    kind: params.run.approvalKind,
  });
  const finalCodexTurnStatus = await waitForCodexApprovalAgentRun({
    context: params.context,
    runId: params.codexRun.runId,
    timeoutMs: params.scenario.timeoutMs,
  });
  if (finalCodexTurnStatus !== "ok") {
    throw new Error(
      `Codex approval run ${params.codexRun.runId} finished with status ${finalCodexTurnStatus}`,
    );
  }
  await assertCodexApprovalOperationSucceeded({
    context: params.context,
    run: params.run,
    sessionKey: params.codexRun.sessionKey,
  });
  const resolved = await waitForSlackApprovalResolvedUpdate({
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    messageTs: pending.message.ts,
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
    extraTextMatches: ["openclaw-codex-app-server", expectedTitle],
  });
  const resolvedCheckpoint = await writeSlackApprovalCheckpoint({
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    decision: params.run.decision,
    message: resolved.message,
    observedAt: resolved.observedAt,
    scenarioId: params.scenario.id,
    state: "resolved",
  });
  const responseObservedAt = new Date(resolved.observedAt);
  return {
    artifact: {
      approvalId,
      approvalKind: params.run.approvalKind,
      appServerMethod: params.run.appServerMethod,
      channelId: params.channelId,
      codexModelKey: params.primaryModel,
      decision: params.run.decision,
      finalCodexTurnStatus,
      operationVerified: true,
      pendingActionValues: pending.actionValues,
      pendingCheckpointPath: pendingCheckpoint?.checkpointPath,
      pendingMessageTs: pending.message.ts,
      pendingScreenshotPath: pendingCheckpoint?.screenshotPath,
      pendingText: pending.message.text,
      resolvedActionValues: resolved.actionValues,
      resolvedCheckpointPath: resolvedCheckpoint?.checkpointPath,
      resolvedMessageTs: resolved.message.ts,
      resolvedScreenshotPath: resolvedCheckpoint?.screenshotPath,
      resolvedText: resolved.message.text,
      threadTs: pending.message.thread_ts,
    } satisfies SlackApprovalArtifact,
    requestStartedAt,
    responseObservedAt,
    rttMs: responseObservedAt.getTime() - requestStartedAt.getTime(),
  };
}

async function waitForSlackChannelRunning(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
  mode: SlackChannelReadinessMode,
): Promise<SlackChannelStatus> {
  const startedAt = Date.now();
  const timeoutMs = resolveSlackQaReadyTimeoutMs();
  let lastStatus: SlackChannelStatus | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            lastConnectedAt?: number;
            lastDisconnect?: unknown;
            lastError?: string | null;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.slack ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match
        ? {
            connected: match.connected,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
            restartPending: match.restartPending,
            running: match.running,
          }
        : undefined;
      if (isSlackChannelReadyForQa(lastStatus, mode)) {
        if (!lastStatus) {
          throw new Error(`slack account "${accountId}" status disappeared after readiness check`);
        }
        return lastStatus;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(
    `slack account "${accountId}" did not become ready` +
      (lastStatus ? `; last status: ${JSON.stringify(lastStatus)}` : ""),
  );
}

async function waitForSlackChannelStable(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
  mode: SlackChannelReadinessMode,
) {
  const startedAt = Date.now();
  const timeoutMs = resolveSlackQaReadyTimeoutMs();
  let readySince: number | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const status = await waitForSlackChannelRunning(gateway, accountId, mode);
    const observedAt = Date.now();
    readySince = resolveSlackChannelReadySince({
      observedAt,
      previousReadySince: readySince,
      status,
    });
    const readyForMs = observedAt - readySince;
    if (readyForMs >= SLACK_QA_READY_STABILITY_MS) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(500, SLACK_QA_READY_STABILITY_MS - readyForMs));
    });
  }
  throw new Error(
    `slack account "${accountId}" did not remain ready for ${SLACK_QA_READY_STABILITY_MS}ms`,
  );
}

function isSlackChannelReadyForQa(
  status: SlackChannelStatus | undefined,
  mode: SlackChannelReadinessMode,
): boolean {
  if (
    !status?.running ||
    status.restartPending === true ||
    status.lastError != null ||
    status.connected === false
  ) {
    return false;
  }
  return mode === "started" || status.connected === true;
}

function resolveSlackChannelReadySince(params: {
  observedAt: number;
  previousReadySince: number | undefined;
  status: SlackChannelStatus;
}): number {
  if (typeof params.status.lastConnectedAt === "number" && params.status.lastConnectedAt > 0) {
    return params.status.lastConnectedAt;
  }
  return params.previousReadySince ?? params.observedAt;
}

function resolveSlackQaReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  if (!raw) {
    return SLACK_QA_DEFAULT_READY_TIMEOUT_MS;
  }
  return parseStrictPositiveInteger(raw) ?? SLACK_QA_DEFAULT_READY_TIMEOUT_MS;
}

function isRetryableSlackQaScenarioError(error: unknown) {
  return /timed out after \d+ms waiting for Slack message/iu.test(formatErrorMessage(error));
}

function toObservedSlackArtifacts(params: {
  includeContent: boolean;
  messages: SlackObservedMessage[];
  redactMetadata: boolean;
}): SlackObservedMessageArtifact[] {
  return params.messages.map((message) => ({
    actionValues: params.includeContent ? message.actionValues : undefined,
    blockText: params.includeContent ? message.blockText : undefined,
    botId: params.redactMetadata ? undefined : message.botId,
    channelId: params.redactMetadata ? undefined : message.channelId,
    matchedScenario: message.matchedScenario,
    scenarioId: message.scenarioId,
    scenarioTitle: message.scenarioTitle,
    text: params.includeContent ? message.text : undefined,
    threadTs: params.redactMetadata ? undefined : message.threadTs,
    ts: params.redactMetadata ? undefined : message.ts,
    userId: params.redactMetadata ? undefined : message.userId,
  }));
}

function toSlackQaScenarioArtifactResults(params: {
  includeContent: boolean;
  redactMetadata: boolean;
  scenarios: SlackQaScenarioResult[];
}): SlackQaScenarioResult[] {
  return params.scenarios.map((scenario) => {
    if (!scenario.approval) {
      return scenario;
    }
    const approval = scenario.approval;
    return {
      ...scenario,
      approval: {
        approvalId: params.redactMetadata ? "<redacted>" : approval.approvalId,
        approvalKind: approval.approvalKind,
        appServerMethod: approval.appServerMethod,
        channelId: params.redactMetadata ? undefined : approval.channelId,
        codexModelKey: approval.codexModelKey,
        decision: approval.decision,
        finalCodexTurnStatus: approval.finalCodexTurnStatus,
        operationVerified: approval.operationVerified,
        pendingActionValues: params.includeContent ? approval.pendingActionValues : undefined,
        pendingCheckpointPath: approval.pendingCheckpointPath,
        pendingMessageTs: params.redactMetadata ? undefined : approval.pendingMessageTs,
        pendingScreenshotPath: approval.pendingScreenshotPath,
        pendingText: params.includeContent ? approval.pendingText : undefined,
        resolvedActionValues: params.includeContent ? approval.resolvedActionValues : undefined,
        resolvedCheckpointPath: approval.resolvedCheckpointPath,
        resolvedMessageTs: params.redactMetadata ? undefined : approval.resolvedMessageTs,
        resolvedScreenshotPath: approval.resolvedScreenshotPath,
        resolvedText: params.includeContent ? approval.resolvedText : undefined,
        threadTs: params.redactMetadata ? undefined : approval.threadTs,
      },
    };
  });
}

function renderSlackQaMarkdown(params: {
  channelId: string;
  cleanupIssues: string[];
  credentialSource: "convex" | "env";
  finishedAt: string;
  gatewayDebugDirPath?: string;
  redactMetadata: boolean;
  scenarios: SlackQaScenarioResult[];
  startedAt: string;
}) {
  const lines = [
    "# Slack QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    `- Channel: \`${params.redactMetadata ? "<redacted>" : params.channelId}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
  ];
  if (params.gatewayDebugDirPath) {
    lines.push(`- Gateway debug artifacts: \`${params.gatewayDebugDirPath}\``);
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("", "## Cleanup issues", "");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`, "");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    if (scenario.approval) {
      lines.push(`- Approval kind: ${scenario.approval.approvalKind}`);
      if (scenario.approval.appServerMethod) {
        lines.push(`- Codex app-server method: \`${scenario.approval.appServerMethod}\``);
      }
      if (scenario.approval.codexModelKey) {
        lines.push(`- Codex model: \`${scenario.approval.codexModelKey}\``);
      }
      if (scenario.approval.finalCodexTurnStatus) {
        lines.push(`- Codex turn status: ${scenario.approval.finalCodexTurnStatus}`);
      }
      if (scenario.approval.operationVerified) {
        lines.push("- Codex operation marker: verified");
      }
      lines.push(`- Approval ID: \`${scenario.approval.approvalId}\``);
      lines.push(`- Decision: ${scenario.approval.decision}`);
      if (scenario.approval.pendingScreenshotPath) {
        lines.push(`- Pending screenshot: \`${scenario.approval.pendingScreenshotPath}\``);
      }
      if (scenario.approval.resolvedScreenshotPath) {
        lines.push(`- Resolved screenshot: \`${scenario.approval.resolvedScreenshotPath}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function preserveSlackGatewayDebugArtifacts(params: {
  cleanupIssues: string[];
  gatewayDebugDirPath: string;
  gatewayHarness: SlackQaGatewayHarness;
}) {
  try {
    await params.gatewayHarness.stop({ preserveToDir: params.gatewayDebugDirPath });
    return true;
  } catch (error) {
    appendLiveLaneIssue(params.cleanupIssues, "gateway debug preservation failed", error);
    return false;
  }
}

export async function runSlackQaLive(params: {
  alternateModel?: string;
  credentialRole?: string;
  credentialSource?: string;
  fastMode?: boolean;
  outputDir?: string;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
}): Promise<SlackQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `slack-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = resolveSlackQaSutAccountId(params.sutAccountId);
  const scenarios = findScenario(params.scenarioIds);
  if (scenarios.some((scenario) => scenario.configOverrides?.codexApproval === true)) {
    assertSlackCodexApprovalModelSupported(primaryModel);
  }
  const requestedCredentialSource = inferSlackCredentialSource(params.credentialSource);
  const redactPublicMetadata = isTruthyOptIn(process.env[QA_REDACT_PUBLIC_METADATA_ENV]);
  const includeObservedMessageContent = isTruthyOptIn(process.env[SLACK_QA_CAPTURE_CONTENT_ENV]);
  const startedAt = new Date().toISOString();
  const observedMessages: SlackObservedMessage[] = [];
  const scenarioResults: SlackQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  let credentialLease: SlackCredentialLease | undefined;
  let leaseHeartbeat: SlackCredentialHeartbeat | undefined;
  let runtimeEnv: SlackQaRuntimeEnv | undefined;

  try {
    credentialLease = await acquireQaCredentialLease({
      kind: "slack",
      source: params.credentialSource,
      role: params.credentialRole,
      resolveEnvPayload: () => resolveSlackQaRuntimeEnv(),
      parsePayload: parseSlackQaCredentialPayload,
    });
    leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
    const assertLeaseHealthy = () => {
      leaseHeartbeat?.throwIfFailed();
    };
    const activeRuntimeEnv = credentialLease.payload;
    runtimeEnv = activeRuntimeEnv;

    const [driverIdentity, sutIdentity] = await Promise.all([
      getSlackIdentity(activeRuntimeEnv.driverBotToken),
      getSlackIdentity(activeRuntimeEnv.sutBotToken),
    ]);
    if (driverIdentity.userId === sutIdentity.userId) {
      throw new Error("Slack QA requires two distinct bots for driver and SUT.");
    }

    const driverClient = createSlackWriteClient(activeRuntimeEnv.driverBotToken, {
      timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
    });
    const sutReadClient = createSlackWebClient(activeRuntimeEnv.sutBotToken, {
      timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
    });
    for (const scenario of scenarios) {
      let scenarioAttempt = 1;
      while (true) {
        let gatewayHarness: SlackQaGatewayHarness | undefined;
        let codexProbeCleanupPath: string | undefined;
        let preserveAttemptGatewayDebug = false;
        let retryScenario = false;
        try {
          assertLeaseHealthy();
          const scenarioRun = scenario.buildRun(sutIdentity.userId);
          if (scenarioRun.kind === "direct-transport") {
            const directResult = await scenarioRun.execute({
              cfg: buildSlackQaConfig(
                {},
                {
                  channelId: activeRuntimeEnv.channelId,
                  driverBotUserId: driverIdentity.userId,
                  overrides: scenario.configOverrides,
                  primaryModel,
                  sutAccountId,
                  sutAppToken: activeRuntimeEnv.sutAppToken,
                  sutBotToken: activeRuntimeEnv.sutBotToken,
                },
              ),
              channelId: activeRuntimeEnv.channelId,
              sutAccountId,
              sutIdentity,
              sutReadClient,
              sutWriteClient: createSlackWriteClient(activeRuntimeEnv.sutBotToken, {
                timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
              }),
              timeoutMs: scenario.timeoutMs,
            });
            const message = directResult.message;
            if (!message.ts) {
              throw new Error("direct Slack transport scenario returned no stored message id");
            }
            observedMessages.push({
              actionValues: collectSlackActionValues(message.blocks),
              blockText: collectSlackBlockText(message.blocks),
              botId: message.bot_id,
              channelId: activeRuntimeEnv.channelId,
              matchedScenario: true,
              scenarioId: scenario.id,
              scenarioTitle: scenario.title,
              text: message.text ?? "",
              threadTs: message.thread_ts,
              ts: message.ts,
              userId: message.user,
            });
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: [
                directResult.details,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
            });
            break;
          }
          gatewayHarness = await startQaLiveLaneGateway({
            repoRoot,
            transport: {
              requiredPluginIds: [],
              createGatewayConfig: () => ({}),
            },
            transportBaseUrl: "http://127.0.0.1:0",
            providerMode,
            primaryModel,
            alternateModel,
            fastMode: params.fastMode,
            forcedRuntime: scenario.forcedRuntime,
            controlUiEnabled: false,
            mutateConfig: (cfg) =>
              buildSlackQaConfig(cfg, {
                channelId: activeRuntimeEnv.channelId,
                driverBotUserId: driverIdentity.userId,
                overrides: scenario.configOverrides,
                primaryModel,
                sutAccountId,
                sutAppToken: activeRuntimeEnv.sutAppToken,
                sutBotToken: activeRuntimeEnv.sutBotToken,
              }),
          });
          const activeGatewayHarness = gatewayHarness;
          if (
            scenarioRun.kind === "codex-approval" &&
            scenarioRun.appServerMethod === "item/fileChange/requestApproval"
          ) {
            codexProbeCleanupPath = resolveCodexFileApprovalTargetPath(scenarioRun.token);
          }
          const readinessMode: SlackChannelReadinessMode =
            scenarioRun.kind === "approval" || scenarioRun.kind === "codex-approval"
              ? "started"
              : "connected";
          await waitForSlackChannelStable(
            activeGatewayHarness.gateway,
            sutAccountId,
            readinessMode,
          );
          const baseScenarioContext = {
            channelId: activeRuntimeEnv.channelId,
            driverClient,
            gateway: activeGatewayHarness.gateway,
            postSlackMessage: async (message: { text: string; threadTs?: string }) =>
              await sendSlackChannelMessage({
                channelId: activeRuntimeEnv.channelId,
                client: driverClient,
                text: message.text,
                threadTs: message.threadTs,
              }),
            sutIdentity,
            sutReadClient,
            waitForReady: async () =>
              await waitForSlackChannelStable(
                activeGatewayHarness.gateway,
                sutAccountId,
                "connected",
              ),
          };
          if (scenarioRun.kind === "approval") {
            const approval = await runSlackApprovalScenario({
              channelId: activeRuntimeEnv.channelId,
              context: baseScenarioContext,
              observedMessages,
              run: scenarioRun,
              scenario,
              sutAccountId,
            });
            scenarioResults.push({
              approval: approval.artifact,
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "pass",
              details: [
                `${scenarioRun.approvalKind} approval resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs: approval.rttMs,
              requestStartedAt: approval.requestStartedAt.toISOString(),
              responseObservedAt: approval.responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: approval.rttMs,
                requestStartedAt: approval.requestStartedAt.toISOString(),
                responseObservedAt: approval.responseObservedAt.toISOString(),
                source: "approval-request-to-resolution",
              },
            });
            break;
          }
          if (scenarioRun.kind === "codex-approval") {
            const approval = await runSlackCodexApprovalScenario({
              channelId: activeRuntimeEnv.channelId,
              context: baseScenarioContext,
              observedMessages,
              primaryModel,
              run: scenarioRun,
              scenario,
              stopGateway: async (preserveDebugArtifacts) => {
                await activeGatewayHarness.stop(
                  preserveDebugArtifacts ? { preserveToDir: gatewayDebugDirPath } : undefined,
                );
                await new Promise((resolve) => {
                  setTimeout(resolve, SLACK_QA_GATEWAY_STOP_SETTLE_MS);
                });
                gatewayHarness = undefined;
                if (preserveDebugArtifacts) {
                  preservedGatewayDebugArtifacts = true;
                }
              },
              sutAccountId,
            });
            scenarioResults.push({
              approval: approval.artifact,
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: [
                `Codex ${scenarioRun.appServerMethod} approval resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs: approval.rttMs,
              requestStartedAt: approval.requestStartedAt.toISOString(),
              responseObservedAt: approval.responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: approval.rttMs,
                requestStartedAt: approval.requestStartedAt.toISOString(),
                responseObservedAt: approval.responseObservedAt.toISOString(),
                source: "approval-request-to-resolution",
              },
            });
            break;
          }
          const beforeRunResult = await scenarioRun.beforeRun?.(baseScenarioContext);
          const beforeRunDetails =
            typeof beforeRunResult === "string" ? beforeRunResult : beforeRunResult?.details;
          // Keep identity checks attempt-local so earlier scenario traffic cannot mask duplicates.
          const observedMessageStartIndex = observedMessages.length;
          const requestStartedAt = new Date();
          const sent = await sendSlackChannelMessage({
            channelId: activeRuntimeEnv.channelId,
            client: driverClient,
            text: scenarioRun.input,
            threadTs:
              typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined,
          });
          const requestThreadTs =
            (typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined) ??
            sent.ts;
          if (scenarioRun.expectReply) {
            const reply = await waitForSlackScenarioReply({
              channelId: activeRuntimeEnv.channelId,
              client: sutReadClient,
              matchText: scenarioRun.matchText,
              observedMessages,
              observationScenarioId: scenario.id,
              observationScenarioTitle: scenario.title,
              sentTs: sent.ts,
              threadTs: requestThreadTs,
              sutIdentity,
              timeoutMs: scenario.timeoutMs,
            });
            scenarioRun.verify?.(reply.message, { requestThreadTs, sentTs: sent.ts });
            if (scenarioRun.settleObservedMs) {
              // Negative and dedupe checks need late Slack deliveries, not only the first final hit.
              await observeSlackScenarioMessages({
                channelId: activeRuntimeEnv.channelId,
                client: sutReadClient,
                matchText: scenarioRun.matchText,
                observedMessages,
                observationScenarioId: scenario.id,
                observationScenarioTitle: scenario.title,
                sentTs: sent.ts,
                settleMs: scenarioRun.settleObservedMs,
                sutIdentity,
                threadTs: requestThreadTs,
              });
            }
            const observedDetails = scenarioRun.verifyObserved?.({
              finalMessage: reply.message,
              messages: observedMessages.slice(observedMessageStartIndex),
            });
            const responseObservedAt = new Date(reply.observedAt);
            const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
            const afterReplyDetails = await scenarioRun.afterReply?.(reply.message, {
              ...baseScenarioContext,
              sentTs: sent.ts,
            });
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "pass",
              details: [
                `reply matched in ${rttMs}ms`,
                beforeRunDetails,
                observedDetails,
                afterReplyDetails,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
              rttMs,
              requestStartedAt: requestStartedAt.toISOString(),
              responseObservedAt: responseObservedAt.toISOString(),
              rttMeasurement: {
                finalMatchedReplyRttMs: rttMs,
                requestStartedAt: requestStartedAt.toISOString(),
                responseObservedAt: responseObservedAt.toISOString(),
                source: "request-to-observed-message",
              },
            });
          } else {
            await waitForSlackNoReply({
              channelId: activeRuntimeEnv.channelId,
              client: sutReadClient,
              matchText: scenarioRun.matchText,
              observedMessages,
              observationScenarioId: scenario.id,
              observationScenarioTitle: scenario.title,
              sentTs: sent.ts,
              sutIdentity,
              timeoutMs: scenario.timeoutMs,
            });
            const afterNoReplyDetails = await scenarioRun.afterNoReply?.({
              ...baseScenarioContext,
              sentTs: sent.ts,
            });
            if (scenarioRun.preserveGatewayDebug) {
              preserveAttemptGatewayDebug = true;
              preservedGatewayDebugArtifacts = true;
            }
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "pass",
              details: [
                "no reply",
                afterNoReplyDetails,
                scenarioAttempt > 1 ? `retried ${scenarioAttempt - 1}x` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
            });
          }
          break;
        } catch (error) {
          if (
            scenarioAttempt < SLACK_QA_RETRYABLE_SCENARIO_ATTEMPTS &&
            isRetryableSlackQaScenarioError(error)
          ) {
            scenarioAttempt += 1;
            retryScenario = true;
          } else {
            scenarioResults.push({
              id: scenario.id,
              title: scenario.title,
              standardId: scenario.standardId,
              status: "fail",
              details:
                scenarioAttempt > 1
                  ? `${formatErrorMessage(error)}; retried ${scenarioAttempt - 1}x`
                  : formatErrorMessage(error),
            });
            if (gatewayHarness) {
              preserveAttemptGatewayDebug = true;
              preservedGatewayDebugArtifacts = true;
              const stopped = await preserveSlackGatewayDebugArtifacts({
                cleanupIssues,
                gatewayDebugDirPath,
                gatewayHarness,
              });
              if (stopped) {
                gatewayHarness = undefined;
              }
            }
          }
        } finally {
          if (gatewayHarness) {
            await gatewayHarness
              .stop(
                preserveAttemptGatewayDebug ? { preserveToDir: gatewayDebugDirPath } : undefined,
              )
              .then(() => {
                gatewayHarness = undefined;
                if (preserveAttemptGatewayDebug) {
                  preservedGatewayDebugArtifacts = true;
                }
              })
              .catch((error: unknown) => {
                appendLiveLaneIssue(cleanupIssues, "gateway stop failed", error);
                retryScenario = false;
                const details = `gateway stop failed: ${formatErrorMessage(error)}`;
                const currentResult = scenarioResults.at(-1);
                if (currentResult?.id === scenario.id) {
                  scenarioResults[scenarioResults.length - 1] = {
                    ...currentResult,
                    status: "fail",
                    details: `${currentResult.details}; ${details}`,
                  };
                } else {
                  scenarioResults.push({
                    id: scenario.id,
                    title: scenario.title,
                    standardId: scenario.standardId,
                    status: "fail",
                    details,
                  });
                }
              });
            if (!gatewayHarness) {
              await new Promise((resolve) => {
                setTimeout(resolve, SLACK_QA_GATEWAY_STOP_SETTLE_MS);
              });
            }
          }
          if (!gatewayHarness && codexProbeCleanupPath) {
            await fs.rm(codexProbeCleanupPath, { force: true }).catch((error: unknown) => {
              appendLiveLaneIssue(cleanupIssues, "Codex approval probe cleanup failed", error);
            });
          }
        }
        if (retryScenario) {
          continue;
        }
        break;
      }
      if (scenarioResults.at(-1)?.status === "fail") {
        break;
      }
    }
  } catch (error) {
    cleanupIssues.push(
      buildLiveLaneArtifactsError({
        heading: "Slack QA failed before scenario completion.",
        details: [formatErrorMessage(error)],
        artifacts: {
          gatewayDebug: gatewayDebugDirPath,
        },
      }),
    );
    preservedGatewayDebugArtifacts = true;
    await fs.mkdir(gatewayDebugDirPath, { recursive: true }).catch(() => {});
    scenarioResults.push({
      id: "slack-canary",
      title: "Slack canary echo",
      standardId: "canary",
      status: "fail",
      details: formatErrorMessage(error),
    });
  } finally {
    if (leaseHeartbeat) {
      try {
        await leaseHeartbeat.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential heartbeat stop failed", error);
      }
    }
    if (credentialLease) {
      try {
        await credentialLease.release();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential release failed", error);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "slack-qa-report.md");
  const summaryPath = path.join(outputDir, QA_EVIDENCE_FILENAME);
  const observedMessagesPath = path.join(outputDir, "slack-qa-observed-messages.json");
  const artifactScenarioResults = toSlackQaScenarioArtifactResults({
    scenarios: scenarioResults,
    includeContent: includeObservedMessageContent,
    redactMetadata: redactPublicMetadata,
  });
  const evidence = buildLiveTransportEvidenceSummary({
    artifactPaths: [
      { kind: "summary", path: path.basename(summaryPath) },
      { kind: "report", path: path.basename(reportPath) },
      { kind: "transport-observations", path: path.basename(observedMessagesPath) },
    ],
    checks: artifactScenarioResults.map(({ standardId, ...check }) => ({
      ...check,
      coverageIds: standardId ? [`channels.slack.${standardId}`] : undefined,
    })),
    env: process.env,
    generatedAt: finishedAt,
    primaryModel,
    providerMode,
    repoRoot,
    transportId: "slack",
  });
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      toObservedSlackArtifacts({
        messages: observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await fs.writeFile(
    reportPath,
    `${renderSlackQaMarkdown({
      channelId: runtimeEnv?.channelId ?? "<unavailable>",
      cleanupIssues,
      credentialSource: credentialLease?.source ?? requestedCredentialSource,
      finishedAt,
      gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
      redactMetadata: redactPublicMetadata,
      scenarios: artifactScenarioResults,
      startedAt,
    })}\n`,
  );
  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
    scenarios: artifactScenarioResults,
  };
}

export const testing = {
  assertSlackCodexApprovalModelSupported,
  assertCodexApprovalTranscriptSucceeded,
  buildCodexApprovalInstruction,
  buildSlackInvalidBlocksTableProbe,
  buildSlackApprovalCheckpointMessage,
  buildSlackQaConfig,
  collectSlackActionValues,
  collectSlackButtonLabels,
  collectSlackBlockText,
  extractSlackNativeApprovalId,
  findPendingCodexPluginApprovalRecord,
  findScenario,
  getSlackIdentity,
  isSlackChannelReadyForQa,
  matchesSlackApprovalResolvedUpdate,
  matchesSlackApprovalPromptText,
  observeSlackScenarioMessages,
  parseSlackNativeApprovalAction,
  parseSlackQaCredentialPayload,
  preserveSlackGatewayDebugArtifacts,
  quiesceCodexApprovalAgentRun,
  readAcceptedAgentRunId,
  resolveCodexFileApprovalTargetPath,
  resolveSlackChannelReadySince,
  resolveSlackQaReadyTimeoutMs,
  resolveSlackApprovalCheckpointConfig,
  resolveApprovalDecision,
  resolveSlackQaSutAccountId,
  resolveSlackQaRuntimeEnv,
  runSlackTableInvalidBlocksFallbackScenario,
  sendSlackChannelMessage,
  listSlackMessages,
  listSlackThreadMessages,
  SLACK_QA_STANDARD_SCENARIO_IDS,
  toSlackQaScenarioArtifactResults,
  waitForSlackStoredMessage,
  waitForSlackNoReply,
  waitForSlackReaction,
  waitForSlackChannelStable,
};
export { testing as __testing };
