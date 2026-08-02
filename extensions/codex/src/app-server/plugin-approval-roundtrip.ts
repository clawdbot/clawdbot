/**
 * Routes Codex app-server plugin approvals through the active run host.
 */
import type {
  EmbeddedRunAttemptParams,
  ExecApprovalDecision,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PLUGIN_APPROVAL_TITLE_LENGTH = 80;
const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 256;

/** Normalized Codex app-server approval outcome after a host decision. */
export type AppServerApprovalOutcome =
  | "approved-once"
  | "approved-session"
  | "denied"
  | "unavailable"
  | "cancelled";

type PluginApprovalHost = NonNullable<EmbeddedRunAttemptParams["approvalHost"]>["plugin"];
type AppServerPluginApprovalResult = Awaited<
  ReturnType<NonNullable<PluginApprovalHost>["request"]>
>;

/** Requests a plugin approval from the host that owns the active agent run. */
export async function requestPluginApproval(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  title: string;
  description: string;
  severity: "info" | "warning";
  toolName: string;
  toolCallId?: string;
  allowedDecisions?: ExecApprovalDecision[];
  signal?: AbortSignal;
  onRegistered?: (registration: { id: string }) => void;
}): Promise<AppServerPluginApprovalResult> {
  const approvalHost = params.paramsForRun.approvalHost?.plugin;
  if (!approvalHost) {
    return {
      outcome: "unavailable",
      reason: "Codex app-server approval route unavailable.",
    };
  }
  return approvalHost.request({
    request: {
      pluginId: "openclaw-codex-app-server",
      title: truncateForHost(params.title, MAX_PLUGIN_APPROVAL_TITLE_LENGTH),
      description: truncateForHost(params.description, MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH),
      severity: params.severity,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      agentId: params.paramsForRun.agentId,
      sessionKey: params.paramsForRun.sessionKey,
      turnSourceChannel: params.paramsForRun.messageChannel ?? params.paramsForRun.messageProvider,
      turnSourceTo:
        params.paramsForRun.currentMessagingTarget ?? params.paramsForRun.currentChannelId,
      turnSourceAccountId: params.paramsForRun.agentAccountId,
      turnSourceThreadId: params.paramsForRun.currentThreadTs,
      ...(params.allowedDecisions ? { allowedDecisions: params.allowedDecisions } : {}),
    },
    timeoutMs: DEFAULT_CODEX_APPROVAL_TIMEOUT_MS,
    signal: params.signal,
    onRegistered: params.onRegistered,
  });
}

/** Converts a host approval result into the app-server approval outcome enum. */
export function mapPluginApprovalResultToOutcome(
  result: AppServerPluginApprovalResult,
): AppServerApprovalOutcome {
  if (result.outcome !== "resolved") {
    return "unavailable";
  }
  if (result.decision === "allow-once") {
    return "approved-once";
  }
  if (result.decision === "allow-always") {
    return "approved-session";
  }
  return "denied";
}

function truncateForHost(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${truncateUtf16Safe(value, maxLength - 3)}...`;
}
