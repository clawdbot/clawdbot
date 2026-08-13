// Raft delivers wake hints only; message content stays in the operator's Raft CLI session.
import { randomUUID } from "node:crypto";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedRaftAccount } from "./accounts.js";
import { RAFT_CHANNEL_ID } from "./accounts.js";

const WAKE_TEXT =
  "Raft wake hint received. Check Raft for pending messages, then reply through the Raft CLI.";

type RaftChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function dispatchRaftWake(params: {
  ctx: ChannelGatewayContext<ResolvedRaftAccount>;
}): Promise<void> {
  const { ctx } = params;
  // Gateway supplies the full runtime; the public context type intentionally
  // exposes only runtime contexts so external plugins cannot assume more.
  const channelRuntime = ctx.channelRuntime as RaftChannelRuntime | undefined;
  const profile = ctx.account.profile;
  if (!channelRuntime || !profile) {
    return;
  }

  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: RAFT_CHANNEL_ID,
    accountId: ctx.accountId,
    peer: {
      kind: "direct",
      id: profile,
    },
  });
  const timestamp = Date.now();
  const command = `raft --profile ${shellQuote(profile)}`;

  await channelRuntime.inbound.run({
    channel: RAFT_CHANNEL_ID,
    accountId: ctx.accountId,
    raw: {
      kind: "wake",
      profile,
    },
    adapter: {
      ingest: () => ({
        id: randomUUID(),
        timestamp,
        rawText: WAKE_TEXT,
        textForAgent: `${WAKE_TEXT}\n\nUse \`${command} message check\` to read pending messages and \`${command} message send\` to respond.`,
        textForCommands: "",
      }),
      resolveTurn: async (input) => {
        const ctxPayload = channelRuntime.inbound.buildContext({
          channel: RAFT_CHANNEL_ID,
          accountId: ctx.accountId,
          messageId: input.id,
          timestamp: input.timestamp,
          from: `raft:${profile}`,
          sender: {
            id: profile,
            name: "Raft",
          },
          conversation: {
            kind: "direct",
            id: profile,
            label: `Raft ${profile}`,
          },
          route: {
            agentId: route.agentId,
            accountId: ctx.accountId,
            routeSessionKey: route.sessionKey,
            dispatchSessionKey: route.sessionKey,
          },
          reply: {
            to: `raft:${profile}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
        });
        return {
          cfg: ctx.cfg,
          channel: RAFT_CHANNEL_ID,
          accountId: ctx.accountId,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          ctxPayload,
          // Raft's bridge only transports wake hints. The agent owns CLI delivery
          // after it reads the pending Raft messages, so OpenClaw must not emit a
          // duplicate synthetic reply through the channel dispatcher.
          delivery: {
            deliver: async () => ({ visibleReplySent: false }),
          },
          record: {
            onRecordError: (error) =>
              ctx.log?.warn?.(`Raft session metadata update failed: ${String(error)}`),
          },
        };
      },
    },
  });
}
