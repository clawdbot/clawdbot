// Tlon plugin module implements channel behavior.
import crypto from "node:crypto";
import type {
  ChannelAccountSnapshot,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { monitorTlonProvider } from "./monitor/index.js";
import { tlonSetupWizard } from "./setup-surface.js";
import { formatTargetHint, normalizeShip, parseTlonTarget } from "./targets.js";
import { configureClient } from "./tlon-api.js";
import { resolveTlonAccount } from "./types.js";
import { authenticate } from "./urbit/auth.js";
import { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./urbit/context.js";
import { urbitFetch } from "./urbit/fetch.js";
import { buildMediaStory, sendDmWithStory, sendGroupMessageWithStory } from "./urbit/send.js";
import { markdownToStory } from "./urbit/story.js";
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
            Cookie: expectDefined(cookie.split(";").at(0), "cookie first segment"),
          },
          body: JSON.stringify([pokeData]),
        },
        ssrfPolicy,
        auditContext: "tlon-poke",
      });

      try {
        if (!response.ok && response.status !== 204) {
          const errorText = await readResponseTextLimited(response, 16 * 1024);
          throw new Error(`Poke failed: ${response.status} - ${errorText}`);
        }

        return pokeId;
      } finally {
        await release();
      }
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
    const missingFields = [
      account.ship ? undefined : "ship",
      account.url ? undefined : "url",
      account.code ? undefined : "code",
    ].filter((field) => field !== undefined);
    throw new Error(
      `Tlon account ${account.accountId} not configured (missing ${missingFields.join(", ")})`,
    );
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

async function sendTlonOutbound(params: ChannelOutboundContext, kind: "text" | "media") {
  const { cfg, to, text, accountId, replyToId, threadId } = params;
  const { account, parsed } = resolveOutboundContext({ cfg, accountId, to });

  let uploadedUrl: string | undefined;
  if (kind === "media") {
    const { mediaUrl } = params;
    configureClient({
      shipUrl: account.url,
      shipName: account.ship.replace(/^~/, ""),
      verbose: false,
      getCode: async () => account.code,
      dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? undefined,
    });
    uploadedUrl = mediaUrl ? await uploadImageFromUrl(mediaUrl, account.mediaMaxBytes) : undefined;
  }

  const api = await createHttpPokeApi({
    url: account.url,
    ship: account.ship,
    code: account.code,
    dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? undefined,
  });
  const fromShip = normalizeShip(account.ship);
  const story = kind === "media" ? buildMediaStory(text, uploadedUrl) : markdownToStory(text);
  if (parsed.kind === "dm") {
    return await sendDmWithStory({
      api,
      fromShip,
      toShip: parsed.ship,
      story,
      kind,
    });
  }
  return await sendGroupMessageWithStory({
    api,
    fromShip,
    hostShip: parsed.hostShip,
    channelName: parsed.channelName,
    story,
    replyToId: resolveReplyId(replyToId, threadId),
    kind,
  });
}

export const tlonRuntimeOutbound: Pick<ChannelOutboundAdapter, "sendText" | "sendMedia"> = {
  sendText: (params) => sendTlonOutbound(params, "text"),
  sendMedia: (params) => sendTlonOutbound(params, "media"),
};

export async function probeTlonAccount(account: ConfiguredTlonAccount, timeoutMs?: number) {
  return await runChannelProbe(
    timeoutMs,
    async () => {
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
    },
    (error) => ({
      ok: false,
      error: (error as { message?: string })?.message ?? String(error),
    }),
  );
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
