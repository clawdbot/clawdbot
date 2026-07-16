import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  definePluginEntry,
  fetchWithSsrFGuard,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "./api.js";

type ThreadOwnershipConfig = {
  forwarderUrl?: string;
  abTestChannels?: string[];
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type ThreadOwnershipMessageSendingResult = { cancel: true } | undefined;

// In-memory set of {channel}:{thread} keys where this agent was @-mentioned.
// Entries expire after 5 minutes.
const mentionedThreads = new Map<string, number>();
const MENTION_TTL_MS = 5 * 60 * 1000;

function cleanExpiredMentions(): void {
  const now = Date.now();
  for (const [key, ts] of mentionedThreads) {
    if (now - ts > MENTION_TTL_MS) {
      mentionedThreads.delete(key);
    }
  }
}

function resolveOwnershipAgent(config: OpenClawConfig): { id: string; name: string } {
  const list = Array.isArray(config.agents?.list)
    ? config.agents.list.filter(
        (entry): entry is AgentEntry => entry !== null && typeof entry === "object",
      )
    : [];
  const selected = list.find((entry) => entry.default === true) ?? list[0];

  const id = normalizeOptionalString(selected?.id) ?? "unknown";
  const identityName = normalizeOptionalString(selected?.identity?.name) ?? "";
  const fallbackName = normalizeOptionalString(selected?.name) ?? "";
  const name = identityName || fallbackName;

  return { id, name };
}

export default definePluginEntry({
  id: "thread-ownership",
  name: "Thread Ownership",
  description: "Slack thread claim coordination for multi-agent setups",
  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as ThreadOwnershipConfig;
    const forwarderUrl = (
      pluginCfg.forwarderUrl ??
      process.env.SLACK_FORWARDER_URL ??
      "http://slack-forwarder:8750"
    ).replace(/\/$/, "");

    const abTestChannels = new Set(
      pluginCfg.abTestChannels ??
        process.env.THREAD_OWNERSHIP_CHANNELS?.split(",").filter(Boolean) ??
        [],
    );

    const { id: agentId, name: agentName } = resolveOwnershipAgent(api.config);
    const botUserId = process.env.SLACK_BOT_USER_ID ?? "";

    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "slack") {
        return;
      }

      const text = event.content ?? "";
      const threadTs = (event.metadata?.threadTs as string) ?? "";
      const channelId = (event.metadata?.channelId as string) ?? ctx.conversationId ?? "";
      if (!threadTs || !channelId) {
        return;
      }

      const mentioned =
        (agentName && text.includes(`@${agentName}`)) ||
        (botUserId && text.includes(`<@${botUserId}>`));
      if (mentioned) {
        cleanExpiredMentions();
        mentionedThreads.set(`${channelId}:${threadTs}`, Date.now());
      }
    });

    api.on("message_sending", async (event, ctx): Promise<ThreadOwnershipMessageSendingResult> => {
      if (ctx.channelId !== "slack") {
        return undefined;
      }

      const threadTs = (event.metadata?.threadTs as string) ?? "";
      const channelId = (event.metadata?.channelId as string) ?? event.to;
      if (!threadTs) {
        return undefined;
      }
      if (abTestChannels.size > 0 && !abTestChannels.has(channelId)) {
        return undefined;
      }

      cleanExpiredMentions();
      if (mentionedThreads.has(`${channelId}:${threadTs}`)) {
        return undefined;
      }

      try {
        // The forwarder is an internal service (e.g. a Docker container); allow private-network
        // access but pin DNS so DNS-rebinding attacks cannot pivot to a different internal host.
        const { response: resp, release } = await fetchWithSsrFGuard({
          url: `${forwarderUrl}/api/v1/ownership/${channelId}/${threadTs}`,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent_id: agentId }),
          },
          timeoutMs: 3000,
          policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
          auditContext: "thread-ownership",
        });

        try {
          if (resp.ok) {
            return undefined;
          }
          if (resp.status === 409) {
            const body = (await resp.json()) as { owner?: string };
            api.logger.info?.(
              `thread-ownership: cancelled send to ${channelId}:${threadTs} — owned by ${body.owner}`,
            );
            return { cancel: true };
          }
          api.logger.warn?.(`thread-ownership: unexpected status ${resp.status}, allowing send`);
        } finally {
          await release();
        }
      } catch (err) {
        api.logger.warn?.(
          `thread-ownership: ownership check failed (${String(err)}), allowing send`,
        );
      }
      return undefined;
    });
  },
});
