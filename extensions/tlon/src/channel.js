import { Urbit } from "@urbit/http-api";
import { unixToDa, formatUd } from "@urbit/aura";

// Polyfill minimal browser globals needed by @urbit/http-api in Node
if (typeof global.window === "undefined") {
  global.window = { fetch: global.fetch };
}
if (typeof global.document === "undefined") {
  global.document = {
    hidden: true,
    addEventListener() {},
    removeEventListener() {},
  };
}

// Patch Urbit.prototype.connect for HTTP authentication
const { connect } = Urbit.prototype;
Urbit.prototype.connect = async function patchedConnect() {
  const resp = await fetch(`${this.url}/~/login`, {
    method: "POST",
    body: `password=${this.code}`,
    credentials: "include",
  });

  if (resp.status >= 400) {
    throw new Error("Login failed with status " + resp.status);
  }

  const cookie = resp.headers.get("set-cookie");
  if (cookie) {
    const match = /urbauth-~([\w-]+)/.exec(cookie);
    if (!this.nodeId && match) {
      this.nodeId = match[1];
    }
    this.cookie = cookie;
  }
  await this.getShipName();
  await this.getOurName();
};

/**
 * Tlon/Urbit channel plugin for Clawdbot
 */
export const tlonPlugin = {
  id: "tlon",
  meta: {
    id: "tlon",
    label: "Tlon",
    selectionLabel: "Tlon/Urbit",
    docsPath: "/channels/tlon",
    docsLabel: "tlon",
    blurb: "Decentralized messaging on Urbit",
    aliases: ["urbit"],
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
  },
  reload: { configPrefixes: ["channels.tlon"] },
  config: {
    listAccountIds: (cfg) => {
      const base = cfg.channels?.tlon;
      if (!base) return [];
      const accounts = base.accounts || {};
      return [
        ...(base.ship ? ["default"] : []),
        ...Object.keys(accounts),
      ];
    },
    resolveAccount: (cfg, accountId) => {
      const base = cfg.channels?.tlon;
      if (!base) {
        return {
          accountId: accountId || "default",
          name: null,
          enabled: false,
          configured: false,
          ship: null,
          url: null,
          code: null,
        };
      }

      const useDefault = !accountId || accountId === "default";
      const account = useDefault ? base : base.accounts?.[accountId];

      return {
        accountId: accountId || "default",
        name: account?.name || null,
        enabled: account?.enabled !== false,
        configured: Boolean(account?.ship && account?.code && account?.url),
        ship: account?.ship || null,
        url: account?.url || null,
        code: account?.code || null,
        groupChannels: account?.groupChannels || [],
        dmAllowlist: account?.dmAllowlist || [],
        notebookChannel: account?.notebookChannel || null,
      };
    },
    defaultAccountId: () => "default",
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const useDefault = !accountId || accountId === "default";

      if (useDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            tlon: {
              ...cfg.channels?.tlon,
              enabled,
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          tlon: {
            ...cfg.channels?.tlon,
            accounts: {
              ...cfg.channels?.tlon?.accounts,
              [accountId]: {
                ...cfg.channels?.tlon?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const useDefault = !accountId || accountId === "default";

      if (useDefault) {
        const { ship, code, url, name, ...rest } = cfg.channels?.tlon || {};
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            tlon: rest,
          },
        };
      }

      const { [accountId]: removed, ...remainingAccounts } =
        cfg.channels?.tlon?.accounts || {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          tlon: {
            ...cfg.channels?.tlon,
            accounts: remainingAccounts,
          },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      ship: account.ship,
      url: account.url,
    }),
  },
  messaging: {
    normalizeTarget: (target) => {
      // Normalize Urbit ship names
      const trimmed = target.trim();
      if (!trimmed.startsWith("~")) {
        return `~${trimmed}`;
      }
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (target) => {
        return /^~?[a-z-]+$/.test(target);
      },
      hint: "~sampel-palnet or sampel-palnet",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => [text], // No chunking for now
    textChunkLimit: 10000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = tlonPlugin.config.resolveAccount(cfg, accountId);

      if (!account.configured) {
        throw new Error("Tlon account not configured");
      }

      // Authenticate with Urbit
      const api = await Urbit.authenticate({
        ship: account.ship.replace(/^~/, ""),
        url: account.url,
        code: account.code,
        verbose: false,
      });

      try {
        // Normalize ship name for sending
        const toShip = to.startsWith("~") ? to : `~${to}`;
        const fromShip = account.ship.startsWith("~")
          ? account.ship
          : `~${account.ship}`;

        // Construct message in Tlon format
        const story = [{ inline: [text] }];
        const sentAt = Date.now();
        const idUd = formatUd(unixToDa(sentAt).toString());
        const id = `${fromShip}/${idUd}`;

        const delta = {
          add: {
            memo: {
              content: story,
              author: fromShip,
              sent: sentAt,
            },
            kind: null,
            time: null,
          },
        };

        const action = {
          ship: toShip,
          diff: { id, delta },
        };

        // Send via poke
        await api.poke({
          app: "chat",
          mark: "chat-dm-action",
          json: action,
        });

        return {
          channel: "tlon",
          success: true,
          messageId: id,
        };
      } finally {
        // Clean up connection
        try {
          await api.delete();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      // TODO: Tlon/Urbit doesn't support media attachments yet
      // For now, send the caption text and include media URL in the message
      const messageText = mediaUrl
        ? `${text}\n\n[Media: ${mediaUrl}]`
        : text;

      // Reuse sendText implementation
      return await tlonPlugin.outbound.sendText({
        cfg,
        to,
        text: messageText,
        accountId,
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) => {
      return accounts.flatMap((account) => {
        if (!account.configured) {
          return [{
            channel: "tlon",
            accountId: account.accountId,
            kind: "config",
            message: "Account not configured (missing ship, code, or url)",
          }];
        }
        return [];
      });
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      ship: snapshot.ship ?? null,
      url: snapshot.url ?? null,
    }),
    probeAccount: async ({ account }) => {
      if (!account.configured) {
        return { ok: false, error: "Not configured" };
      }

      try {
        const api = await Urbit.authenticate({
          ship: account.ship.replace(/^~/, ""),
          url: account.url,
          code: account.code,
          verbose: false,
        });

        try {
          await api.getOurName();
          return { ok: true };
        } finally {
          await api.delete();
        }
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      ship: account.ship,
      url: account.url,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        ship: account.ship,
        url: account.url,
      });
      ctx.log?.info(
        `[${account.accountId}] starting Tlon provider for ${account.ship}`
      );

      // Lazy import to avoid circular dependencies
      const { monitorTlonProvider } = await import("./monitor.js");

      return monitorTlonProvider({
        account,
        accountId: account.accountId,
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};

// Export tlonPlugin for use by index.ts
export { tlonPlugin };
