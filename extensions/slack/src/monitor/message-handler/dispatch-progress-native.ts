import type { AnyChunk } from "@slack/types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { appendSlackStream, startSlackStream } from "../../streaming.js";
import { resolveSlackStreamRecipientTeamId } from "./dispatch-helpers.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import type { SlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";

export function createSlackNativeProgressTransport(params: {
  setup: Pick<
    SlackDispatchSetup,
    "ctx" | "message" | "slackClient" | "slackIdentity" | "slackStreamFallbackTeamId"
  >;
  delivery: SlackStreamingDeliveryRuntime;
}) {
  const { ctx, message, slackClient, slackIdentity, slackStreamFallbackTeamId } = params.setup;
  const { delivery } = params;

  const markDelivered = (threadTs?: string) => {
    const session = delivery.streamSession;
    if (!session?.delivered) {
      return false;
    }
    delivery.observedReplyDelivery = true;
    if (threadTs) {
      delivery.usedReplyThreadTs ??= threadTs;
      delivery.rememberDeliveredThreadTs("block", threadTs);
    }
    return true;
  };

  const waitForStart = async (): Promise<boolean> => {
    if (delivery.streamSession || !delivery.nativeProgressStreamStartPromise) {
      return true;
    }
    try {
      await delivery.nativeProgressStreamStartPromise;
    } catch {
      delivery.streamFailed = true;
      return false;
    }
    return !delivery.streamFailed;
  };

  const start = async (update: { text?: string; chunks?: AnyChunk[] }): Promise<boolean> => {
    const streamThreadTs = delivery.nextStreamThreadTs();
    if (!streamThreadTs) {
      logVerbose(
        "slack-stream: no reply thread target for native progress stream start, falling back",
      );
      delivery.streamFailed = true;
      return false;
    }
    delivery.nativeProgressStreamThreadTs = streamThreadTs;
    delivery.startStreamBoundaryTracking();
    const startPromise = (async () => {
      const session = await startSlackStream({
        client: slackClient,
        channel: message.channel,
        threadTs: streamThreadTs,
        ...(update.text ? { text: update.text } : {}),
        ...(update.chunks?.length ? { chunks: update.chunks } : {}),
        taskDisplayMode: "plan",
        ...(slackIdentity ? { identity: slackIdentity } : {}),
        teamId: await resolveSlackStreamRecipientTeamId({
          client: slackClient,
          token: ctx.botToken,
          userId: message.user,
          fallbackTeamId: slackStreamFallbackTeamId,
        }),
        userId: message.user,
      });
      delivery.streamSession = session;
      delivery.syncStreamBoundaryMessageTs(session);
      return session;
    })();
    delivery.nativeProgressStreamStartPromise = startPromise;
    try {
      const session = await startPromise;
      if (!session) {
        return false;
      }
      const delivered = markDelivered(streamThreadTs);
      return update.chunks?.length ? delivered : true;
    } finally {
      if (delivery.nativeProgressStreamStartPromise === startPromise) {
        delivery.nativeProgressStreamStartPromise = null;
      }
    }
  };

  const append = async (update: { text?: string; chunks?: AnyChunk[] }): Promise<boolean> => {
    const session = delivery.streamSession;
    if (!session) {
      return false;
    }
    await appendSlackStream({
      session,
      ...(update.text ? { text: update.text } : {}),
      ...(update.chunks?.length ? { chunks: update.chunks } : {}),
    });
    delivery.syncStreamBoundaryMessageTs(session);
    const delivered = markDelivered(delivery.nativeProgressStreamThreadTs);
    return update.chunks?.length ? delivered : true;
  };

  return { append, start, waitForStart };
}
