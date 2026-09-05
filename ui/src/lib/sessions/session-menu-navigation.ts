import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import type { ChatHistoryResult } from "../../pages/chat/chat-history-snapshot.ts";
import { buildChatMarkdown } from "../../pages/chat/export.ts";
import type { SessionSplitHost } from "../../pages/chat/split-layout-types.ts";
import { nativeHistoryMessageIdentity } from "../chat/history-message-identity.ts";
import { copyToClipboard } from "../clipboard.ts";
import { formatUiError } from "../format-error.ts";
import { reserveExternalWindowForDeferredNavigation } from "../open-external-url.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import { showToast } from "../toast.ts";
import {
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "./route-navigation.ts";
import { parseAgentSessionKey } from "./session-key.ts";

type SessionNavigationActionKind =
  | "copy-session-id"
  | "copy-session-link"
  | "copy-markdown"
  | "open-new-tab"
  | "open-new-window"
  | "split-right"
  | "split-below";

type SessionNavigationTarget<TRouteId extends string> = {
  context: ApplicationContext<TRouteId>;
  session: Pick<GatewaySessionRow, "key" | "sessionId">;
  agentId?: string;
  sourceSessionKey?: string;
  isCurrent: () => boolean;
};

export function canSplitSessionView(): boolean {
  return (
    document.querySelector<SessionSplitHost>("openclaw-chat-page")?.sessionSplitAvailable === true
  );
}

export function canCopySessionMarkdown(snapshot: ApplicationGatewaySnapshot | undefined): boolean {
  return readSessionMethodAccess(snapshot, {
    method: "chat.history",
    requiredScope: "operator.read",
  }).allowed;
}

async function copySessionMarkdown<TRouteId extends string>(
  params: SessionNavigationTarget<TRouteId>,
): Promise<boolean> {
  const { context, session } = params;
  const gateway = context.gateway;
  const client = gateway.snapshot.client;
  const access = readSessionMethodAccess(gateway.snapshot, {
    method: "chat.history",
    requiredScope: "operator.read",
  });
  if (!access.allowed || !client) {
    throw new Error(access.allowed ? t("sessionsView.actionRequiresConnection") : access.reason);
  }
  const agentId =
    parseAgentSessionKey(session.key)?.agentId ??
    resolveSessionNavigationAgentId(context, params.agentId);
  const hello = gateway.snapshot.hello;
  const isCurrent = () =>
    params.isCurrent() &&
    gateway.snapshot.client === client &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.hello === hello;
  const pages: unknown[][] = [];
  const seenCounts = new Map<string, number>();
  const requestHistory = (offset: number, limit = 1000) =>
    client.request<ChatHistoryResult>("chat.history", {
      sessionKey: session.key,
      agentId,
      limit,
      maxChars: 500_000,
      offset,
    });
  let offset = 0;
  let snapshot: ChatHistoryResult | undefined;
  while (true) {
    const page = await requestHistory(offset);
    // Offsets are relative to the current tail. Never stitch different sessions,
    // branches, or growing transcripts into a seemingly complete export.
    if (
      !isCurrent() ||
      (session.sessionId && page.sessionId !== session.sessionId) ||
      (snapshot &&
        (page.sessionId !== snapshot.sessionId || page.totalMessages !== snapshot.totalMessages))
    ) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
    snapshot ??= page;
    const pageCounts = new Map<string, number>();
    const messages = (page.messages ?? []).filter((message) => {
      const identity = nativeHistoryMessageIdentity(message);
      if (!identity) {
        return true;
      }
      const count = (pageCounts.get(identity) ?? 0) + 1;
      pageCounts.set(identity, count);
      return count > (seenCounts.get(identity) ?? 0);
    });
    for (const [identity, count] of pageCounts) {
      seenCounts.set(identity, Math.max(count, seenCounts.get(identity) ?? 0));
    }
    pages.push(messages);
    if (!page.hasMore) {
      break;
    }
    if (page.nextOffset === undefined || page.nextOffset <= offset) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
    offset = page.nextOffset;
  }
  if (pages.length > 1) {
    // Only tail pages carry the branch marker and history cursor. Re-read the
    // tail after paging so a branch switch or rewrite cannot mix transcripts.
    const tail = await requestHistory(0, 1);
    if (
      !isCurrent() ||
      tail.sessionId !== snapshot.sessionId ||
      tail.totalMessages !== snapshot.totalMessages ||
      tail.deltaCursor !== snapshot.deltaCursor ||
      tail.sessionInfo?.activeLeafEntryId !== snapshot.sessionInfo?.activeLeafEntryId
    ) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
  }
  const assistantName =
    context.agents.state.agentsList?.agents.find((agent) => agent.id === agentId)?.name ??
    "OpenClaw";
  const markdown = buildChatMarkdown(pages.toReversed().flat(), assistantName);
  if (!markdown) {
    throw new Error(t("chat.commandResults.emptyExport"));
  }
  return copyToClipboard(markdown, isCurrent);
}

export async function runSessionNavigationAction<TRouteId extends string>(
  kind: SessionNavigationActionKind,
  params: SessionNavigationTarget<TRouteId>,
): Promise<void> {
  try {
    if (kind === "split-right" || kind === "split-below") {
      const handled =
        canSplitSessionView() &&
        !window.dispatchEvent(
          new CustomEvent(UI_COMMAND_EVENT, {
            detail: {
              command: {
                kind: "split",
                direction: kind === "split-right" ? "right" : "down",
                sessionKey: params.session.key,
              },
              ...(params.sourceSessionKey ? { sessionKey: params.sourceSessionKey } : {}),
            },
            cancelable: true,
          }),
        );
      if (!handled) {
        showToast({ message: t("sessionsView.splitUnavailable") });
      }
      return;
    }
    if (kind === "copy-markdown" || kind === "copy-session-id") {
      const copied =
        kind === "copy-markdown"
          ? await copySessionMarkdown(params)
          : await copyToClipboard(params.session.sessionId ?? "");
      showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
      return;
    }
    const face = resolveSessionPreferredFaceForKey(
      params.context,
      params.session.key,
      params.agentId,
    );
    const gateway = params.context.gateway;
    // Shared links belong to the Gateway; the UI document may be a local SSH
    // tunnel or a dev server with a different mount path. New windows stay local.
    const linkBase =
      kind === "copy-session-link"
        ? (gateway.snapshot.hello?.controlUiUrl ??
          gateway.snapshot.client?.gatewayUrl ??
          gateway.connection.gatewayUrl)
        : undefined;
    const url = new URL(linkBase || window.location.href);
    url.protocol = url.protocol.replace(/^ws/u, "http");
    const navigation = sessionNavigationTarget({
      context: params.context,
      basePath: linkBase ? url.pathname : undefined,
      face,
      sessionKey: params.session.key,
      agentId: params.agentId,
      exactKey: true,
    });
    const href = new URL(navigation.href, url.origin).href;
    if (kind === "copy-session-link") {
      const copied = await copyToClipboard(href);
      showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
      return;
    }
    // Reserve an inert page so popup blocking remains observable, and detach
    // its opener before loading the same-origin session route.
    const opened = reserveExternalWindowForDeferredNavigation({
      popup: kind === "open-new-window",
    });
    if (opened) {
      opened.location.replace(href);
    } else {
      showToast({ message: t("sessionsView.openWindowBlocked") });
    }
  } catch (error) {
    showToast({ message: formatUiError(error) });
  }
}
