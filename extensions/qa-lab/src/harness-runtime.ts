import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

type SessionRecord = {
  sessionKey: string;
  body: string;
};

export function createQaRunnerRuntime(): PluginRuntime {
  const sessions = new Map<string, SessionRecord>();
  return {
    channel: {
      routing: {
        resolveAgentRoute({
          accountId,
          peer,
        }: {
          accountId?: string | null;
          peer?: { kind?: string; id?: string } | null;
        }) {
          return {
            agentId: "qa-agent",
            accountId: accountId ?? "default",
            sessionKey: `qa-agent:${peer?.kind ?? "direct"}:${peer?.id ?? "default"}`,
            mainSessionKey: "qa-agent:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
            channel: "qa-channel",
          };
        },
      },
      session: {
        resolveStorePath(_store: string | undefined, { agentId }: { agentId: string }) {
          return agentId;
        },
        readSessionUpdatedAt({ sessionKey }: { sessionKey: string }) {
          return sessions.has(sessionKey) ? Date.now() : undefined;
        },
        recordInboundSession({
          sessionKey,
          ctx,
        }: {
          sessionKey: string;
          ctx: { BodyForAgent?: string; Body?: string };
        }) {
          sessions.set(sessionKey, {
            sessionKey,
            body: ctx.BodyForAgent ?? ctx.Body ?? "",
          });
        },
      },
      mentions: {
        buildMentionRegexes,
        matchesMentionPatterns,
        matchesMentionWithExplicit,
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
      reply: {
        resolveEnvelopeFormatOptions() {
          return {};
        },
        formatAgentEnvelope({ body }: { body: string }) {
          return body;
        },
        finalizeInboundContext(ctx: Record<string, unknown>) {
          return ctx as typeof ctx & { CommandAuthorized: boolean };
        },
        async dispatchReplyWithBufferedBlockDispatcher({
          ctx,
          dispatcherOptions,
        }: {
          ctx: { BodyForAgent?: string; Body?: string };
          dispatcherOptions: { deliver: (payload: { text: string }) => Promise<void> };
        }) {
          await dispatcherOptions.deliver({
            text: `qa-echo: ${ctx.BodyForAgent ?? ctx.Body ?? ""}`,
          });
        },
      },
    },
  } as unknown as PluginRuntime;
}
