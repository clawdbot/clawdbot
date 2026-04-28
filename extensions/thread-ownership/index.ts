import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
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

function isThreadOwnershipConfig(value: unknown): value is ThreadOwnershipConfig {
  return value !== null && typeof value === "object";
}

function resolveThreadToken(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveSlackConversationId(value: unknown): string {
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return "";
  }
  const trimmed = raw.trim();
  const match = /^(?:slack:)?channel:(.+)$/i.exec(trimmed);
  const resolved = match?.[1]?.trim() || trimmed;
  return /^[CDGUW][A-Z0-9]+$/i.test(resolved) ? resolved.toUpperCase() : resolved;
}

function cleanExpiredMentions(): void {
  const now = Date.now();
  for (const [key, ts] of mentionedThreads) {
    if (now - ts > MENTION_TTL_MS) {
      mentionedThreads.delete(key);
    }
  }
}

function containsAgentNameMention(text: string, agentName: string): boolean {
  const trimmedName = agentName.trim();
  if (!trimmedName) {
    return false;
  }
  return new RegExp(`(^|[^\\w])@${escapeRegExp(trimmedName)}(?=$|[^\\w])`, "i").test(text);
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
    const resolveCurrentState = () => {
      const currentConfig = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
      const livePluginCfg = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "thread-ownership",
        isThreadOwnershipConfig(api.pluginConfig)
          ? (api.pluginConfig as Record<string, unknown>)
          : undefined,
      );
      const pluginCfg = isThreadOwnershipConfig(livePluginCfg) ? livePluginCfg : {};
      return {
        currentConfig,
        forwarderUrl: (
          pluginCfg.forwarderUrl ??
          process.env.SLACK_FORWARDER_URL ??
          "http://slack-forwarder:8750"
        ).replace(/\/$/, ""),
        abTestChannels: new Set(
          (
            pluginCfg.abTestChannels ??
            process.env.THREAD_OWNERSHIP_CHANNELS?.split(",").filter(Boolean) ??
            []
          )
            .map((entry) => resolveSlackConversationId(entry))
            .filter(Boolean),
        ),
        botUserId: process.env.SLACK_BOT_USER_ID ?? "",
        agent: resolveOwnershipAgent(currentConfig),
      };
    };

    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "slack") {
        return;
      }
      const { agent, botUserId } = resolveCurrentState();

      const text = event.content ?? "";
      const threadTs =
        resolveThreadToken(event.threadId) ||
        resolveThreadToken(event.metadata?.threadId) ||
        resolveThreadToken(event.metadata?.threadTs);
      const channelId =
        resolveSlackConversationId(ctx.conversationId) ||
        resolveSlackConversationId(event.metadata?.channelId) ||
        "";
      if (!threadTs || !channelId) {
        return;
      }

      const mentioned =
        containsAgentNameMention(text, agent.name) ||
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
      const { abTestChannels, agent, forwarderUrl } = resolveCurrentState();

      const threadTs =
        resolveThreadToken(event.replyToId) ||
        resolveThreadToken(event.threadId) ||
        resolveThreadToken(event.metadata?.threadId) ||
        resolveThreadToken(event.metadata?.threadTs);
      const channelId =
        resolveSlackConversationId(ctx.conversationId) ||
        resolveSlackConversationId(event.metadata?.channelId) ||
        resolveSlackConversationId(event.to) ||
        "";
      if (!threadTs || !channelId) {
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
            body: JSON.stringify({ agent_id: agent.id }),
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
