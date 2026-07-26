// QA Lab Slack live domain contracts and wire schemas.
import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { z } from "zod";
import type { startQaGatewayChild } from "../../gateway-child.js";
import { splitQaModelRef } from "../../model-selection.js";
import type { RuntimeId } from "../../runtime-parity.js";

export type SlackQaRuntimeEnv = {
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutAppToken: string;
};

export type SlackChannelStatus = {
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string | null;
  restartPending?: boolean;
  running?: boolean;
};

export type SlackChannelReadinessMode = "connected" | "started";

export const SLACK_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;
export const SLACK_QA_READY_STABILITY_MS = 3_000;
export const SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS = 30_000;
export const SLACK_QA_APPROVAL_CHECKPOINT_DEFAULT_TIMEOUT_MS = 120_000;
export const SLACK_QA_REACTION_VERIFY_TIMEOUT_MS = 15_000;
export const SLACK_QA_NATIVE_DATA_VERIFY_TIMEOUT_MS = 15_000;
export const SLACK_QA_INVALID_TABLE_DATA_ROW_COUNT = 101;
export const SLACK_QA_LOG_TAIL_TIMEOUT_MS = 20_000;
export const SLACK_QA_INVALID_TABLE_CAPTION = "QA invalid_blocks fallback";
export const SLACK_QA_INVALID_TABLE_HEADERS = ["Row", "Value"] as const;
export const SLACK_QA_CHART_TITLE = "QA latency trend";
export const SLACK_QA_CHART_CATEGORIES = ["P50", "P95"] as const;
export const SLACK_QA_CHART_SERIES_NAME = "Latency";
export const SLACK_QA_CHART_VALUES = [120, 240] as const;
export const SLACK_QA_CHART_X_LABEL = "Percentile";
export const SLACK_QA_CHART_Y_LABEL = "Milliseconds";
export const SLACK_QA_TABLE_CAPTION = "QA pipeline report";
export const SLACK_QA_TABLE_HEADERS = ["Account", "Stage", "ARR"] as const;
export const SLACK_QA_TABLE_ROWS = [
  ["Acme", "Won", 125_000],
  ["Globex", "Review", 82_000],
] as const;
export const SLACK_QA_NATIVE_CHART = {
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
export const SLACK_QA_NATIVE_TABLE = {
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

export type SlackQaScenarioId =
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

export type SlackQaApprovalKind = "exec" | "plugin";
export type SlackQaApprovalDecision = "allow-always" | "allow-once" | "deny";
export const SLACK_QA_APPROVAL_ACTION_PREFIX = "openclaw:approval:v1:";
export const SlackQaApprovalActionValueSchema = z
  .object({
    approvalId: z.string().min(1),
    approvalKind: z.enum(["exec", "plugin"]),
    decision: z.enum(["allow-always", "allow-once", "deny"]),
  })
  .strict();
export type SlackQaCodexApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval";

export function assertSlackCodexApprovalModelSupported(modelRef: string) {
  const provider = splitQaModelRef(modelRef)?.provider.trim().toLowerCase();
  if (provider && SLACK_QA_CODEX_PROVIDER_IDS.has(provider)) {
    return;
  }
  throw new Error(
    `Slack Codex approval scenarios require an openai/* or codex/* model; received "${modelRef}".`,
  );
}

export type SlackQaMessageScenarioRun = {
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

export type SlackQaDirectTransportScenarioContext = {
  cfg: OpenClawConfig;
  channelId: string;
  sutAccountId: string;
  sutIdentity: SlackAuthIdentity;
  sutReadClient: WebClient;
  sutWriteClient: WebClient;
  timeoutMs: number;
};

export type SlackQaDirectTransportScenarioResult = {
  details: string;
  message: SlackMessage;
};

export type SlackQaApprovalScenarioRun = {
  approvalKind: SlackQaApprovalKind;
  decision: SlackQaApprovalDecision;
  kind: "approval";
  token: string;
};

export type SlackQaCodexApprovalScenarioRun = {
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

export type SlackQaConfigOverrides = {
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

export type SlackQaScenarioContext = {
  channelId: string;
  driverClient: WebClient;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  postSlackMessage: (params: { text: string; threadTs?: string }) => Promise<{ ts: string }>;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
  sutReadClient: WebClient;
  waitForReady: () => Promise<void>;
};

export type SlackQaScenarioDefinition = {
  id: SlackQaScenarioId;
  title: string;
  timeoutMs: number;
  buildRun: (sutUserId: string) => SlackQaScenarioRun;
  configOverrides?: SlackQaConfigOverrides;
  forcedRuntime?: RuntimeId;
};

export type SlackAuthIdentity = {
  botId?: string;
  teamId?: string;
  userId: string;
};

export type SlackObservedMessage = {
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

export type SlackApprovalArtifact = {
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

export type SlackApprovalCheckpointState = "pending" | "resolved";

export type SlackApprovalCheckpointAck = {
  capturedAt?: string;
  screenshotPath?: string;
};

export type SlackApprovalCheckpointMessage = {
  actionLabels: string[];
  blockText: string[];
  hasNativeActions: boolean;
  text: string;
};

export const SLACK_QA_APPROVAL_CHECKPOINT_DIR_ENV = "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR";
export const SLACK_QA_APPROVAL_CHECKPOINT_TIMEOUT_MS_ENV =
  "OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS";
export const SLACK_QA_WEB_API_TIMEOUT_MS = 45_000;
export const SLACK_QA_ENV_KEYS = [
  "OPENCLAW_QA_SLACK_CHANNEL_ID",
  "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN",
  "OPENCLAW_QA_SLACK_SUT_APP_TOKEN",
] as const;

export const slackQaCredentialPayloadSchema = z.object({
  channelId: z.string().trim().min(1),
  driverBotToken: z.string().trim().min(1),
  sutBotToken: z.string().trim().min(1),
  sutAppToken: z.string().trim().min(1),
});

export const slackAuthTestSchema = z.object({
  ok: z.boolean().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
  team_id: z.string().optional(),
});

export const slackPostMessageSchema = z.object({
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

export type SlackMessage = Omit<z.infer<typeof slackHistoryMessageSchema>, "ts"> & { ts?: string };

export const slackHistorySchema = z.object({
  ok: z.boolean().optional(),
  messages: z.array(slackHistoryMessageSchema).optional(),
});

export const slackRepliesSchema = z.object({
  ok: z.boolean().optional(),
  messages: z.array(slackHistoryMessageSchema).optional(),
});
