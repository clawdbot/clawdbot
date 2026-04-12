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
  return {
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
