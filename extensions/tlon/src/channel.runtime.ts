import crypto from "node:crypto";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { monitorTlonProvider } from "./monitor/index.js";
import { tlonSetupWizard } from "./setup-surface.js";
import {
  formatTargetHint,
  normalizeShip,
  parseTlonTarget,
  resolveTlonOutboundTarget,
} from "./targets.js";
import { configureClient } from "./tlon-api.js";
import { resolveTlonAccount } from "./types.js";
import { authenticate } from "./urbit/auth.js";
import { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./urbit/context.js";
import { urbitFetch } from "./urbit/fetch.js";
import {
  buildMediaStory,
  sendDm,
  sendDmWithStory,
  sendGroupMessage,
  sendGroupMessageWithStory,
} from "./urbit/send.js";
import { uploadImageFromUrl } from "./urbit/upload.js";

type ResolvedTlonAccount = ReturnType<typeof resolveTlonAccount>;
type ConfiguredTlonAccount = ResolvedTlonAccount & {
  ship: string;
  url: string;
  code: string;
};

async function createHttpPokeApi(params: {
  url: string;
  code: string;
  ship: string;
  dangerouslyAllowPrivateNetwork?: boolean;
}) {
  const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(
    params.dangerouslyAllowPrivateNetwork,
  );
  const cookie = await authenticate(params.url, params.code, { ssrfPolicy });
  const channelId = `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID()}`;
  const channelPath = `/~/channel/${channelId}`;
  const shipName = params.ship.replace(/^~/, "");

  return {
    poke: async (pokeParams: { app: string; mark: string; json: unknown }) => {
      const pokeId = Date.now();
      const pokeData = {
        id: pokeId,
        action: "poke",
        ship: shipName,
        app: pokeParams.app,
        mark: pokeParams.mark,
        json: pokeParams.json,
      };

      const { response, release } = await urbitFetch({
        baseUrl: params.url,
        path: channelPath,
        init: {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie.split(";")[0],
          },
          body: JSON.stringify([pokeData]),
        },
        ssrfPolicy,
        auditContext: "tlon-poke",
      });

      try {
        if (!response.ok && response.status !== 204) {
          const errorText = await response.text();
          throw new Error(`Poke failed: ${response.status} - ${errorText}`);
        }

        return pokeId;
      } finally {
        await release();
      }
    },
    delete: async () => {
      // No-op for HTTP-only client
    },
  };
}

function resolveOutboundContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}) {
  const account = resolveTlonAccount(params.cfg, params.accountId ?? undefined);
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured");
  }

  const parsed = parseTlonTarget(params.to);
  if (!parsed) {
    throw new Error(`Invalid Tlon target. Use ${formatTargetHint()}`);
  }

  return { account: account as ConfiguredTlonAccount, parsed };
}

function resolveReplyId(replyToId?: string | null, threadId?: string | number | null) {
  return (replyToId ?? threadId) ? String(replyToId ?? threadId) : undefined;
}

async function withHttpPokeAccountApi<T>(
  account: ConfiguredTlonAccount,
  run: (api: Awaited<ReturnType<typeof createHttpPokeApi>>) => Promise<T>,
) {
  const api = await createHttpPokeApi({
    url: account.url,
    ship: account.ship,
    code: account.code,
    dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? undefined,
  });

  try {
    return await run(api);
  } finally {
    try {
      await api.delete();
    } catch {
      // ignore cleanup errors
    }
  }
}

export const tlonRuntimeOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 10000,
  resolveTarget: ({ to }) => resolveTlonOutboundTarget(to),
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    const { account, parsed } = resolveOutboundContext({ cfg, accountId, to });
    return withHttpPokeAccountApi(account, async (api) => {
      const fromShip = normalizeShip(account.ship);
      if (parsed.kind === "dm") {
        return await sendDm({
          api,
          fromShip,
          toShip: parsed.ship,
          text,
        });
      }
      return await sendGroupMessage({
        api,
        fromShip,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName,
        text,
        replyToId: resolveReplyId(replyToId, threadId),
      });
    });
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
    const { account, parsed } = resolveOutboundContext({ cfg, accountId, to });

    configureClient({
      shipUrl: account.url,
      shipName: account.ship.replace(/^~/, ""),
      verbose: false,
      getCode: async () => account.code,
      dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? undefined,
    });

    const uploadedUrl = mediaUrl ? await uploadImageFromUrl(mediaUrl) : undefined;
    return withHttpPokeAccountApi(account, async (api) => {
      const fromShip = normalizeShip(account.ship);
      const story = buildMediaStory(text, uploadedUrl);

      if (parsed.kind === "dm") {
        return await sendDmWithStory({
          api,
          fromShip,
          toShip: parsed.ship,
          story,
        });
      }
      return await sendGroupMessageWithStory({
        api,
        fromShip,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName,
        story,
        replyToId: resolveReplyId(replyToId, threadId),
      });
    });
  },
};

export async function probeTlonAccount(account: ConfiguredTlonAccount) {
  try {
    const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(
      account.dangerouslyAllowPrivateNetwork,
    );
    const cookie = await authenticate(account.url, account.code, { ssrfPolicy });
    const { response, release } = await urbitFetch({
      baseUrl: account.url,
      path: "/~/name",
      init: {
        method: "GET",
        headers: { Cookie: cookie },
      },
      ssrfPolicy,
      timeoutMs: 30_000,
      auditContext: "tlon-probe-account",
    });
    try {
      if (!response.ok) {
        return { ok: false, error: `Name request failed: ${response.status}` };
      }
      return { ok: true };
    } finally {
      await release();
    }
  } catch (error) {
    return { ok: false, error: (error as { message?: string })?.message ?? String(error) };
  }
}

export async function startTlonGatewayAccount(
  ctx: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedTlonAccount>["gateway"]>["startAccount"]>
  >[0],
) {
  const account = ctx.account;
  ctx.setStatus({
    accountId: account.accountId,
    ship: account.ship,
    url: account.url,
  } as ChannelAccountSnapshot);
  ctx.log?.info(`[${account.accountId}] starting Tlon provider for ${account.ship ?? "tlon"}`);
  return monitorTlonProvider({
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
    accountId: account.accountId,
  });
}

export { tlonSetupWizard };
