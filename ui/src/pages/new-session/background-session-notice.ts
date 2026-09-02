import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";

type AgentWaitResult = {
  status?: "error" | "ok" | "pending" | "timeout";
  endedAt?: number;
  error?: string;
  providerStarted?: boolean;
  stopReason?: string;
};

const RETRY_DELAY_MS = 1_000;

const delayRetry = () =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, RETRY_DELAY_MS);
  });

async function notifyWhenBackgroundSessionEnds(params: {
  agentId: string;
  client: GatewayBrowserClient;
  context: ApplicationContext;
  key: string;
  runId: string;
}): Promise<void> {
  let result: AgentWaitResult | undefined;
  while (!result) {
    try {
      const observed = await params.client.request<AgentWaitResult>(
        "agent.wait",
        { runId: params.runId, timeoutMs: 30_000 },
        { timeoutMs: null },
      );
      if (params.context.gateway.snapshot.client !== params.client) {
        return;
      }
      const observationalTimeout =
        observed.status === "timeout" &&
        observed.endedAt === undefined &&
        !observed.error &&
        !observed.stopReason &&
        observed.providerStarted !== true;
      if (observed.status === "pending") {
        await delayRetry();
      } else if (observationalTimeout) {
        const placement = params.context.placementStartup.get(params.key);
        if (placement?.phase === "failed") {
          result = { status: "error", error: placement.error };
        } else if (params.context.placementStartup.hasPendingTurn(params.key)) {
          await delayRetry();
        } else {
          result = observed;
        }
      } else {
        result = observed;
      }
    } catch {
      const gateway = params.context.gateway.snapshot;
      const reconnecting =
        gateway.phase === "connecting" ||
        gateway.phase === "starting" ||
        gateway.phase === "reconnecting";
      if (gateway.client !== params.client || !reconnecting) {
        return;
      }
      await delayRetry();
    }
  }

  const gateway = params.context.gateway.snapshot;
  if (
    uiSessionEventMatches(
      { ...gateway, sessionKey: gateway.sessionKey },
      params.key,
      params.agentId,
    )
  ) {
    return;
  }
  const row = params.context.sessions.state.result?.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, params.key),
  );
  const status =
    result.status === "ok"
      ? t("sessionsView.statusDone")
      : result.status === "timeout"
        ? t("sessionsView.statusTimeout")
        : result.stopReason === "rpc"
          ? t("sessionsView.statusKilled")
          : t("sessionsView.statusFailed");
  showToast({
    fifo: true,
    message: `${resolveSessionDisplayName(params.key, row)}: ${status}`,
    actionLabel: t("sessionsView.openSession"),
    onAction: () => {
      selectApplicationSession({
        selection: params.context.agentSelection,
        gateway: params.context.gateway,
        sessionKey: params.key,
        agentId: params.agentId,
      });
      params.context.navigate(
        "chat",
        sessionNavigationTarget({
          context: params.context,
          face: "chat",
          sessionKey: params.key,
          agentId: params.agentId,
        }).options,
      );
    },
  });
}

export function prepareBackgroundSessionCompletion(params: {
  enabled: boolean;
  agentId: string;
  client: GatewayBrowserClient;
  context: ApplicationContext;
  clearDraft: () => void;
}): (key: string, runId?: string) => boolean {
  return (key, runId) => {
    const normalizedRunId = runId?.trim();
    if (!params.enabled || !normalizedRunId) {
      return false;
    }
    params.clearDraft();
    void notifyWhenBackgroundSessionEnds({
      agentId: params.agentId,
      client: params.client,
      context: params.context,
      key,
      runId: normalizedRunId,
    });
    return true;
  };
}
