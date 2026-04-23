import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type AutoThreadResolver = (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  toolContext?: Record<string, unknown>;
  replyToId?: string;
}) => string | undefined;

type OutboundThreadContext = {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  toolContext?: Record<string, unknown>;
  resolveAutoThreadId?: AutoThreadResolver;
};

function resolveOutboundThreadId(
  actionParams: Record<string, unknown>,
  context: OutboundThreadContext,
): string | undefined {
  const explicit = typeof actionParams.threadId === "string" ? actionParams.threadId : undefined;
  const replyToId = typeof actionParams.replyTo === "string" ? actionParams.replyTo : undefined;
  const resolved =
    explicit ??
    context.resolveAutoThreadId?.({
      cfg: context.cfg,
      accountId: context.accountId,
      to: context.to,
      toolContext: context.toolContext,
      replyToId,
    });
  if (resolved && !actionParams.threadId) {
    actionParams.threadId = resolved;
  }
  return resolved ?? undefined;
}

export function createOutboundThreadingMock() {
  const resolveOutboundReplyToId = vi.fn(
    (
      actionParams: Record<string, unknown>,
      context: {
        channel: string;
        toolContext?: {
          currentChannelId?: string;
          currentChannelProvider?: string;
          currentMessageId?: string | number;
          replyToMode?: "off" | "first" | "all" | "batched";
          hasRepliedRef?: { value: boolean };
        };
      },
    ) => {
      const explicitReplyTo =
        typeof actionParams.replyTo === "string" ? actionParams.replyTo.trim() : "";
      if (explicitReplyTo) {
        if (context.toolContext?.replyToMode === "first" && context.toolContext.hasRepliedRef) {
          context.toolContext.hasRepliedRef.value = true;
        }
        return explicitReplyTo;
      }

      const currentChannelId = context.toolContext?.currentChannelId?.trim();
      const currentChannelProvider = context.toolContext?.currentChannelProvider?.trim();
      if (
        !currentChannelId ||
        (currentChannelProvider && currentChannelProvider !== context.channel)
      ) {
        return undefined;
      }

      const explicitTarget =
        typeof actionParams.target === "string"
          ? actionParams.target
          : typeof actionParams.to === "string"
            ? actionParams.to
            : typeof actionParams.channelId === "string"
              ? actionParams.channelId
              : undefined;
      if (explicitTarget && explicitTarget.trim() !== currentChannelId) {
        return undefined;
      }

      const currentMessageId = context.toolContext?.currentMessageId;
      if (currentMessageId == null) {
        return undefined;
      }

      const replyToMode = context.toolContext?.replyToMode ?? "off";
      if (replyToMode === "off" || replyToMode === "batched") {
        return undefined;
      }

      if (replyToMode === "first") {
        const hasRepliedRef = context.toolContext?.hasRepliedRef;
        if (hasRepliedRef?.value) {
          return undefined;
        }
        if (hasRepliedRef) {
          hasRepliedRef.value = true;
        }
      }

      const resolvedReplyToId =
        typeof currentMessageId === "number" ? String(currentMessageId) : currentMessageId.trim();
      if (!resolvedReplyToId) {
        return undefined;
      }
      actionParams.replyTo = resolvedReplyToId;
      return resolvedReplyToId;
    },
  );

  return {
    resolveAndApplyOutboundReplyToId: resolveOutboundReplyToId,
    resolveAndApplyOutboundThreadId: vi.fn(resolveOutboundThreadId),
    prepareOutboundMirrorRoute: vi.fn(
      async ({
        actionParams,
        cfg,
        to,
        accountId,
        toolContext,
        agentId,
        resolveAutoThreadId,
      }: {
        actionParams: Record<string, unknown>;
        cfg: OpenClawConfig;
        to: string;
        accountId?: string | null;
        toolContext?: Record<string, unknown>;
        agentId?: string;
        resolveAutoThreadId?: AutoThreadResolver;
      }) => {
        const resolvedThreadId = resolveOutboundThreadId(actionParams, {
          cfg,
          accountId,
          to,
          toolContext,
          resolveAutoThreadId,
        });
        if (agentId) {
          actionParams.__agentId = agentId;
        }
        return {
          resolvedThreadId,
          outboundRoute: null,
        };
      },
    ),
  };
}
