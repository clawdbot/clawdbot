import type { WebAPICallResult, WebClient } from "@slack/web-api";
import { defaultRuntime, logVerbose, warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatSlackError } from "./errors.js";

type SlackSessionStatus = "processing" | "active" | "suspended";
type SlackSessionRequest = {
  channel_id: string;
  thread_ts: string;
  token?: string;
  title?: string;
};
type SlackSessionResponse = WebAPICallResult & {
  warning?: string;
  status?: SlackSessionStatus | "closed";
  agent_status?: SlackSessionStatus | "closed";
  title?: string;
};

const MISSING_STOP_SUBSCRIPTION = "missing_agent_session_stopped_event_subscription";
let warnedMissingStopSubscription = false;

// The installed WebClient supports these public methods through apiCall; the
// dedicated method types arrive in 8.1.x after its release-age gate clears.
export async function setSlackSessionStatus(params: {
  client: WebClient;
  channelId: string;
  threadTs?: string;
  status: SlackSessionStatus;
  title?: string;
  token?: string;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true; title?: string } | { ok: false }> {
  if (!params.threadTs) {
    return { ok: false };
  }
  const request: SlackSessionRequest & { status: SlackSessionStatus } = {
    channel_id: params.channelId,
    thread_ts: params.threadTs,
    status: params.status,
    ...(params.token ? { token: params.token } : {}),
    ...(params.title !== undefined ? { title: truncateUtf16Safe(params.title, 200) } : {}),
  };
  try {
    const response: SlackSessionResponse = await params.client.apiCall(
      "agents.sessions.setStatus",
      request,
    );
    if (
      !warnedMissingStopSubscription &&
      (response.warning === MISSING_STOP_SUBSCRIPTION ||
        response.response_metadata?.warnings?.includes(MISSING_STOP_SUBSCRIPTION))
    ) {
      warnedMissingStopSubscription = true;
      (params.runtime ?? defaultRuntime).log?.(
        warn(
          "Slack's Stop button is unavailable until the app subscribes to agent_session_stopped. See https://docs.openclaw.ai/channels/slack#additional-manifest-settings",
        ),
      );
    }
    return response.ok ? { ok: true, title: response.title } : { ok: false };
  } catch (error) {
    logVerbose(
      `slack status update failed for channel ${params.channelId}: ${formatSlackError(error)}`,
    );
    return { ok: false };
  }
}

export async function renameSlackSession(params: {
  client: WebClient;
  channelId: string;
  threadTs: string;
  title: string;
  token?: string;
}): Promise<boolean> {
  const request: SlackSessionRequest & { title: string } = {
    channel_id: params.channelId,
    thread_ts: params.threadTs,
    title: truncateUtf16Safe(params.title, 200),
    ...(params.token ? { token: params.token } : {}),
  };
  try {
    const response: SlackSessionResponse = await params.client.apiCall(
      "agents.sessions.rename",
      request,
    );
    return response.ok;
  } catch (error) {
    logVerbose(
      `slack session rename failed for channel ${params.channelId}: ${formatSlackError(error)}`,
    );
    return false;
  }
}
