import { randomBytes } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const DAY_MS = 24 * 60 * 60 * 1000;
const DISCORD_EPOCH_MS = 1_420_070_400_000;
const WIDGET_TTL_MS = 7 * DAY_MS;
const SESSION_TTL_MS = 15 * 60 * 1000;
const DOC_TOKEN_TTL_MS = 60 * 1000;
const PENDING_LAUNCH_TTL_MS = 2 * 60 * 1000;

type DiscordActivityWidget = {
  html: string;
  title: string;
  channelId: string;
  accountId: string;
  createdAt: number;
  deliveredMessageId?: string | null;
};

type DiscordActivitySession = {
  discordUserId: string;
  accountId: string;
};

type DiscordActivityDocToken = {
  widgetId: string;
  accountId: string;
};

type DiscordActivityPendingLaunch =
  | { state: "single"; widgetId: string; createdAt: number }
  | { state: "ambiguous"; createdAt: number };

type AtomicPluginStateKeyedStore<T> = PluginStateKeyedStore<T> & {
  update: NonNullable<PluginStateKeyedStore<T>["update"]>;
};

type DiscordActivityStores = {
  widgets: AtomicPluginStateKeyedStore<DiscordActivityWidget>;
  sessions: PluginStateKeyedStore<DiscordActivitySession>;
  docTokens: PluginStateKeyedStore<DiscordActivityDocToken>;
  launches: AtomicPluginStateKeyedStore<DiscordActivityPendingLaunch>;
};

type OpenKeyedStore = <T>(options: {
  namespace: string;
  maxEntries: number;
  overflowPolicy: "evict-oldest";
  defaultTtlMs: number;
}) => PluginStateKeyedStore<T>;

function requireAtomicUpdate<T>(store: PluginStateKeyedStore<T>): AtomicPluginStateKeyedStore<T> {
  if (!store.update) {
    throw new Error("Discord Activities require atomic plugin state updates");
  }
  return store as AtomicPluginStateKeyedStore<T>;
}

export function openDiscordActivityStores(openKeyedStore: OpenKeyedStore): DiscordActivityStores {
  return {
    widgets: requireAtomicUpdate(
      openKeyedStore<DiscordActivityWidget>({
        namespace: "activities-widgets",
        maxEntries: 64,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: WIDGET_TTL_MS,
      }),
    ),
    sessions: openKeyedStore<DiscordActivitySession>({
      namespace: "activities-sessions",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: SESSION_TTL_MS,
    }),
    docTokens: openKeyedStore<DiscordActivityDocToken>({
      namespace: "activities-doc-tokens",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: DOC_TOKEN_TTL_MS,
    }),
    launches: requireAtomicUpdate(
      openKeyedStore<DiscordActivityPendingLaunch>({
        namespace: "activities-launches",
        maxEntries: 256,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: PENDING_LAUNCH_TTL_MS,
      }),
    ),
  };
}

function pendingLaunchKey(accountId: string, channelId: string, discordUserId: string): string {
  return `${accountId}:${channelId}:${discordUserId}`;
}

export class DiscordActivityStore {
  private lastWidgetCreatedAt = 0;

  constructor(private readonly stores: DiscordActivityStores) {}

  async createWidget(value: DiscordActivityWidget): Promise<string> {
    const id = randomBytes(16).toString("base64url");
    const createdAt = Math.max(value.createdAt, this.lastWidgetCreatedAt + 1);
    this.lastWidgetCreatedAt = createdAt;
    await this.stores.widgets.register(id, { ...value, createdAt, deliveredMessageId: null });
    return id;
  }

  async markWidgetDelivered(id: string, messageId: string): Promise<void> {
    if (!/^\d+$/u.test(messageId)) {
      throw new Error("Discord Activity delivery returned an invalid message ID");
    }
    const updated = await this.stores.widgets.update(id, (widget) =>
      widget ? { ...widget, deliveredMessageId: messageId } : undefined,
    );
    if (!updated) {
      throw new Error("Discord Activity widget disappeared before delivery was recorded");
    }
  }

  async deleteWidget(id: string): Promise<void> {
    await this.stores.widgets.delete(id);
  }

  async lookupWidget(id: string): Promise<DiscordActivityWidget | undefined> {
    return await this.stores.widgets.lookup(id);
  }

  async latestPostedWidgetForChannel(
    accountId: string,
    channelId: string,
  ): Promise<{
    id: string;
    widget: DiscordActivityWidget;
  } | null> {
    const entries = await this.stores.widgets.entries();
    let match: { entry: (typeof entries)[number]; deliveryOrder: bigint } | undefined;
    for (const entry of entries) {
      if (entry.value.accountId !== accountId || entry.value.channelId !== channelId) {
        continue;
      }
      // Discord snowflakes preserve canonical message order even when API responses arrive out of
      // order. Pre-tracking records fall back to their creation time; null marks a pending send.
      if (entry.value.deliveredMessageId === null) {
        continue;
      }
      const deliveryOrder = entry.value.deliveredMessageId
        ? BigInt(entry.value.deliveredMessageId)
        : BigInt(Math.max(0, Math.trunc(entry.value.createdAt - DISCORD_EPOCH_MS))) << 22n;
      if (!match || deliveryOrder > match.deliveryOrder) {
        match = { entry, deliveryOrder };
      }
    }
    return match ? { id: match.entry.key, widget: match.entry.value } : null;
  }

  async createSession(value: DiscordActivitySession): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.stores.sessions.register(token, value);
    return token;
  }

  async lookupSession(token: string): Promise<DiscordActivitySession | undefined> {
    return await this.stores.sessions.lookup(token);
  }

  async createDocToken(value: DiscordActivityDocToken): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.stores.docTokens.register(token, value);
    return token;
  }

  async consumeDocToken(token: string): Promise<DiscordActivityDocToken | undefined> {
    return await this.stores.docTokens.consume(token);
  }

  async recordPendingLaunch(params: {
    accountId: string;
    channelId: string;
    discordUserId: string;
    widgetId: string;
    createdAt: number;
  }): Promise<void> {
    const key = pendingLaunchKey(params.accountId, params.channelId, params.discordUserId);
    // Overlapping clicks on different widgets are ambiguous: which Activity queries first is
    // unordered, so a single slot could hand widget B's record to widget A's shell. Poison the
    // slot instead; consume then returns nothing and resolution falls through to the newest post.
    await this.stores.launches.update(key, (existing) => {
      const overlapsDifferentWidget =
        existing && (existing.state === "ambiguous" || existing.widgetId !== params.widgetId);
      return overlapsDifferentWidget
        ? { state: "ambiguous", createdAt: params.createdAt }
        : { state: "single", widgetId: params.widgetId, createdAt: params.createdAt };
    });
  }

  async retirePendingLaunch(
    accountId: string,
    channelId: string,
    discordUserId: string,
    widgetId: string,
  ): Promise<void> {
    // Close the launch lifecycle when custom_id resolution succeeds so a completed
    // launch cannot poison the next click on a different widget for the whole TTL.
    // Different-widget and ambiguous records stay: their Activities may still query.
    const key = pendingLaunchKey(accountId, channelId, discordUserId);
    await this.stores.launches.update(key, (existing) =>
      existing?.state === "single" && existing.widgetId === widgetId ? undefined : existing,
    );
  }

  async consumePendingLaunch(
    accountId: string,
    channelId: string,
    discordUserId: string,
  ): Promise<Extract<DiscordActivityPendingLaunch, { state: "single" }> | undefined> {
    const launch = await this.stores.launches.consume(
      pendingLaunchKey(accountId, channelId, discordUserId),
    );
    return launch?.state === "single" ? launch : undefined;
  }
}
