import {
  type createChannelProgressWorkCounter,
  formatChannelProgressDraftText,
  type ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveGatewayPublicOrigin } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { buildControlUiSessionPath } from "openclaw/plugin-sdk/session-discussion";
import { createSlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { buildSlackProgressCardBlocks } from "../../progress-blocks.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";
import {
  combineProgressHeadlineAndExplanation,
  resolveStructuredProgressLines,
} from "./dispatch-progress-render.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";

type DraftProgressCardState = "working" | "success" | "error";

export function createSlackDraftProgressCardRuntime(params: {
  setup: Pick<SlackDispatchSetup, "account" | "cfg" | "ctx" | "prepared" | "slackClient">;
  draftStream: ReturnType<typeof createSlackDraftStream> | undefined;
  enabled: boolean;
  progressWorkCounter: ReturnType<typeof createChannelProgressWorkCounter> | undefined;
  progressSeed: string;
  explicitTitle: string | undefined;
  maxLineChars: number;
  getSnapshot: () => ChannelProgressDraftCompositorSnapshot;
  getThreadTs: () => string | undefined;
}) {
  const { account, cfg, ctx, prepared, slackClient } = params.setup;
  let latestFallbackText = "";
  let finalStatus: Exclude<DraftProgressCardState, "working"> | undefined;

  const resolveSessionUrl = () => {
    // Both conditions are the operator's own statement that this session is
    // openable: `publicOrigin` is where the Gateway is externally reachable,
    // and the Control UI is what serves the session route. Installations that
    // set neither, or that replaced the Control UI, get no dead link.
    if (cfg.gateway?.controlUi?.enabled === false) {
      return undefined;
    }
    const publicOrigin = resolveGatewayPublicOrigin(cfg);
    if (!publicOrigin) {
      return undefined;
    }
    const url = new URL(publicOrigin);
    const path = buildControlUiSessionPath({
      namespace: "chat",
      sessionKey: prepared.route.sessionKey,
      fallbackAgentId: prepared.route.agentId,
      basePath: cfg.gateway?.controlUi?.basePath,
    });
    if (!path) {
      return undefined;
    }
    url.pathname = path;
    return url.toString();
  };

  const resolveText = (snapshot: ChannelProgressDraftCompositorSnapshot) =>
    latestFallbackText ||
    formatChannelProgressDraftText({
      entry: account.config,
      lines: [...snapshot.lines],
      seed: params.progressSeed,
      formatLine: formatSlackProgressDraftLine,
      narration: snapshot.statusHeadline,
      plan: snapshot.plan,
    });

  const resolvePresentation = (
    snapshot: ChannelProgressDraftCompositorSnapshot,
    state: DraftProgressCardState,
  ) => {
    const title = params.explicitTitle ?? snapshot.statusHeadline ?? "Working";
    const narration = params.explicitTitle
      ? combineProgressHeadlineAndExplanation(snapshot.statusHeadline, snapshot.planExplanation)
      : snapshot.planExplanation && snapshot.planExplanation !== title
        ? snapshot.planExplanation
        : undefined;
    const workCounter = state === "working" ? params.progressWorkCounter : undefined;
    const sessionUrl = state === "working" ? undefined : resolveSessionUrl();
    return buildSlackProgressCardBlocks({
      state,
      title,
      narration,
      plan: snapshot.plan,
      lines: resolveStructuredProgressLines(snapshot.lines),
      maxLineChars: params.maxLineChars,
      diffStat: snapshot.diffStat,
      toolCalls: workCounter?.toolCalls,
      elapsedSeconds: workCounter?.elapsedSeconds,
      sessionUrl,
    });
  };

  const finalize = async (
    status: Exclude<DraftProgressCardState, "working">,
    snapshot = params.getSnapshot(),
    fallbackText = resolveText(snapshot),
  ): Promise<boolean> => {
    if (!params.draftStream || !params.enabled) {
      return false;
    }
    await params.draftStream.dropDetachedMessages();
    const terminalStatus = finalStatus === "error" || status === "error" ? "error" : "success";
    if (finalStatus === terminalStatus) {
      return true;
    }
    await params.draftStream.flush();
    const channelId = params.draftStream.channelId();
    const messageId = params.draftStream.messageId();
    if (!channelId || !messageId) {
      return false;
    }
    await params.draftStream.seal();
    try {
      const finalized = await params.draftStream.finalizeMessage(messageId, async () => {
        await finalizeSlackPreviewEdit({
          client: slackClient,
          token: ctx.botToken,
          accountId: account.accountId,
          channelId,
          messageId,
          text: fallbackText,
          blocks: resolvePresentation(snapshot, terminalStatus),
          threadTs: params.getThreadTs(),
        });
      });
      if (finalized) {
        finalStatus = terminalStatus;
      }
      return finalized;
    } catch (err) {
      logVerbose(`slack: progress card final edit failed (${formatSlackError(err)})`);
      return false;
    }
  };

  return {
    resolveSessionUrl,
    resolveText,
    resolvePresentation,
    finalize,
    get hasTerminalized() {
      return finalStatus !== undefined;
    },
    setFallbackText(text: string) {
      latestFallbackText = text;
    },
    reset() {
      latestFallbackText = "";
      finalStatus = undefined;
    },
  };
}

export function formatSlackProgressDraftLine(line: string): string {
  if (/^(?:🧠|💬)\s/u.test(line)) {
    return line;
  }

  const italicCommentary = /^_(.*)_$/su.exec(line);
  if (!italicCommentary) {
    return escapeSlackMrkdwn(line);
  }

  const content = normalizeSlackOutboundText(italicCommentary[1]!, {
    mentions: "escape",
    enclosingStyle: "italic",
  });

  return `_${content}_`;
}
