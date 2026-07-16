import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { getMattermostRuntime } from "../runtime.js";
import { updateMattermostPost, type MattermostClient, type MattermostPost } from "./client.js";
import { isTrustedProxyAddress, resolveClientIp, type OpenClawConfig } from "./runtime-api.js";

const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
const INTERACTION_BODY_TIMEOUT_MS = 10_000;
const SIGNED_CHANNEL_ID_CONTEXT_KEY = "__openclaw_channel_id";

/**
 * Mattermost interactive message callback payload.
 * Sent by Mattermost when a user clicks an action button.
 * See: https://developers.mattermost.com/integrate/plugins/interactive-messages/
 */
export type MattermostInteractionPayload = {
  user_id: string;
  user_name?: string;
  channel_id: string;
  team_id?: string;
  post_id: string;
  trigger_id?: string;
  type?: string;
  data_source?: string;
  context?: Record<string, unknown>;
};

export type MattermostInteractionResponse = {
  update?: {
    message: string;
    props?: Record<string, unknown>;
  };
  ephemeral_text?: string;
};

export type MattermostInteractionAuthorizationResult =
  | { ok: true }
  | { ok: false; statusCode?: number; response?: MattermostInteractionResponse };

export type MattermostInteractiveButtonInput = {
  id?: string;
  callback_data?: string;
  text?: string;
  name?: string;
  label?: string;
  style?: "default" | "primary" | "danger";
  context?: Record<string, unknown>;
};

// ── Callback URL registry ──────────────────────────────────────────────

const callbackUrls = new Map<string, string>();

export function setInteractionCallbackUrl(accountId: string, url: string): void {
  callbackUrls.set(accountId, url);
}

export function getInteractionCallbackUrl(accountId: string): string | undefined {
  return callbackUrls.get(accountId);
}

type InteractionCallbackConfig = Pick<OpenClawConfig, "gateway" | "channels"> & {
  interactions?: {
    callbackBaseUrl?: string;
  };
};

export function resolveInteractionCallbackPath(accountId: string): string {
  return `/mattermost/interactions/${accountId}`;
}

function isWildcardBindHost(rawHost: string): boolean {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return false;
  }
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}

function normalizeCallbackBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return normalizeOptionalString(value[0]);
  }
  return normalizeOptionalString(value);
}

function isAllowedInteractionSource(params: {
  req: IncomingMessage;
  allowedSourceIps?: string[];
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}): boolean {
  const { allowedSourceIps } = params;
  if (!allowedSourceIps?.length) {
    return true;
  }

  const clientIp = resolveClientIp({
    remoteAddr: params.req.socket?.remoteAddress,
    forwardedFor: headerValue(params.req.headers["x-forwarded-for"]),
    realIp: headerValue(params.req.headers["x-real-ip"]),
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
  });
  return isTrustedProxyAddress(clientIp, allowedSourceIps);
}

/**
 * Resolve the interaction callback URL for an account.
 * Falls back to computing it from interactions.callbackBaseUrl or gateway host config.
 */
export function computeInteractionCallbackUrl(
  accountId: string,
  cfg?: InteractionCallbackConfig,
): string {
  const path = resolveInteractionCallbackPath(accountId);
  // Prefer merged per-account config when available, but keep the top-level path for
  // callers/tests that still pass the root Mattermost config shape directly.
  const callbackBaseUrl =
    normalizeOptionalString(cfg?.interactions?.callbackBaseUrl) ??
    normalizeOptionalString(cfg?.channels?.mattermost?.interactions?.callbackBaseUrl);
  if (callbackBaseUrl) {
    return `${normalizeCallbackBaseUrl(callbackBaseUrl)}${path}`;
  }
  const port = typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789;
  let host =
    cfg?.gateway?.customBindHost && !isWildcardBindHost(cfg.gateway.customBindHost)
      ? cfg.gateway.customBindHost.trim()
      : "localhost";

  // Bracket IPv6 literals so the URL is valid: http://[::1]:18789/...
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }

  return `http://${host}:${port}${path}`;
}

/**
 * Resolve the interaction callback URL for an account.
 * Prefers the in-memory registered URL (set by the gateway monitor) so callers outside the
 * monitor lifecycle can reuse the runtime-validated callback destination.
 */
export function resolveInteractionCallbackUrl(
  accountId: string,
  cfg?: InteractionCallbackConfig,
): string {
  const cached = callbackUrls.get(accountId);
  if (cached) {
    return cached;
  }
  return computeInteractionCallbackUrl(accountId, cfg);
}

// ── HMAC token management ──────────────────────────────────────────────
// Secret is derived from the bot token so it's stable across CLI and gateway processes.

const interactionSecrets = new Map<string, string>();
let defaultInteractionSecret: string | undefined;

function deriveInteractionSecret(botToken: string): string {
  return createHmac("sha256", "openclaw-mattermost-interactions").update(botToken).digest("hex");
}

export function setInteractionSecret(accountIdOrBotToken: string, botToken?: string): void {
  if (typeof botToken === "string") {
    interactionSecrets.set(accountIdOrBotToken, deriveInteractionSecret(botToken));
    return;
  }
  // Backward-compatible fallback for call sites/tests that only pass botToken.
  defaultInteractionSecret = deriveInteractionSecret(accountIdOrBotToken);
}

export function getInteractionSecret(accountId?: string): string {
  const scoped = accountId ? interactionSecrets.get(accountId) : undefined;
  if (scoped) {
    return scoped;
  }
  if (defaultInteractionSecret) {
    return defaultInteractionSecret;
  }
  // Fallback for single-account runtimes that only registered scoped secrets.
  if (interactionSecrets.size === 1) {
    const first = interactionSecrets.values().next().value;
    if (typeof first === "string") {
      return first;
    }
  }
  throw new Error(
    "Interaction secret not initialized — call setInteractionSecret(accountId, botToken) first",
  );
}

function canonicalizeInteractionContext(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeInteractionContext(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeInteractionContext(entryValue)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function generateInteractionToken(
  context: Record<string, unknown>,
  accountId?: string,
): string {
  const secret = getInteractionSecret(accountId);
  const payload = JSON.stringify(canonicalizeInteractionContext(context));
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyInteractionToken(
  context: Record<string, unknown>,
  token: string,
  accountId?: string,
): boolean {
  const expected = generateInteractionToken(context, accountId);
  return safeEqualSecret(expected, token);
}

// ── Button builder helpers ─────────────────────────────────────────────

export type MattermostButton = {
  id: string;
  type: "button" | "select";
  name: string;
  style?: "default" | "primary" | "danger";
  integration: {
    url: string;
    context: Record<string, unknown>;
  };
};

export type MattermostAttachment = {
  text?: string;
  actions?: MattermostButton[];
  [key: string]: unknown;
};

/**
 * Build Mattermost `props.attachments` with interactive buttons.
 *
 * Each button includes an HMAC token in its integration context so the
 * callback handler can verify the request originated from a legitimate
 * button click (Mattermost's recommended security pattern).
 */
/**
 * Sanitize a button ID so Mattermost's action router can match it.
 * Mattermost uses the action ID in the URL path `/api/v4/posts/{id}/actions/{actionId}`
 * and IDs containing hyphens or underscores break the server-side routing.
 * See: https://github.com/mattermost/mattermost/issues/25747
 */
function sanitizeActionId(id: string): string {
  return id.replace(/[-_]/g, "");
}

export function buildButtonAttachments(params: {
  callbackUrl: string;
  accountId?: string;
  buttons: Array<{
    id: string;
    name: string;
    style?: "default" | "primary" | "danger";
    context?: Record<string, unknown>;
  }>;
  text?: string;
}): MattermostAttachment[] {
  const actions: MattermostButton[] = params.buttons.map((btn) => {
    const safeId = sanitizeActionId(btn.id);
    const context: Record<string, unknown> = {
      action_id: safeId,
      ...btn.context,
    };
    const token = generateInteractionToken(context, params.accountId);
    return {
      id: safeId,
      type: "button" as const,
      name: btn.name,
      style: btn.style,
      integration: {
        url: params.callbackUrl,
        context: {
          ...context,
          _token: token,
        },
      },
    };
  });

  return [
    {
      text: params.text ?? "",
      actions,
    },
  ];
}

export function buildButtonProps(params: {
  callbackUrl: string;
  accountId?: string;
  channelId: string;
  buttons: Array<unknown>;
  text?: string;
}): Record<string, unknown> | undefined {
  const rawButtons = params.buttons.flatMap((item) =>
    Array.isArray(item) ? item : [item],
  ) as MattermostInteractiveButtonInput[];

  const buttons = rawButtons
    .map((btn) => ({
      id: normalizeStringifiedOptionalString(btn.id ?? btn.callback_data) ?? "",
      name: normalizeStringifiedOptionalString(btn.text ?? btn.name ?? btn.label) ?? "",
      style: btn.style ?? "default",
      context:
        typeof btn.context === "object" && btn.context !== null
          ? {
              ...btn.context,
              [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId,
            }
          : { [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId },
    }))
    .filter((btn) => btn.id && btn.name);

  if (buttons.length === 0) {
    return undefined;
  }

  return {
    attachments: buildButtonAttachments({
      callbackUrl: params.callbackUrl,
      accountId: params.accountId,
      buttons,
      text: params.text,
    }),
  };
}

// ── Request body reader ────────────────────────────────────────────────

function readInteractionBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("Request body read timeout"));
    }, INTERACTION_BODY_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > INTERACTION_MAX_BODY_BYTES) {
        req.destroy();
        clearTimeout(timer);
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── HTTP handler ───────────────────────────────────────────────────────

export function createMattermostInteractionHandler(params: {
  client: MattermostClient;
  botUserId: string;
  accountId: string;
  allowedSourceIps?: string[];
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  resolveSessionKey?: (params: {
    channelId: string;
    userId: string;
    post: MattermostPost;
  }) => Promise<string>;
  handleInteraction?: (opts: {
    payload: MattermostInteractionPayload;
    userName: string;
    actionId: string;
    actionName: string;
    originalMessage: string;
    context: Record<string, unknown>;
    post: MattermostPost;
  }) => Promise<MattermostInteractionResponse | null>;
  authorizeButtonClick?: (opts: {
    payload: MattermostInteractionPayload;
    post: MattermostPost;
  }) => Promise<MattermostInteractionAuthorizationResult>;
  dispatchButtonClick?: (opts: {
    channelId: string;
    userId: string;
    userName: string;
    actionId: string;
    actionName: string;
    postId: string;
    post: MattermostPost;
  }) => Promise<void>;
  log?: (message: string) => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { client, accountId, log } = params;
  const core = getMattermostRuntime();

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    if (
      !isAllowedInteractionSource({
        req,
        allowedSourceIps: params.allowedSourceIps,
        trustedProxies: params.trustedProxies,
        allowRealIpFallback: params.allowRealIpFallback,
      })
    ) {
      log?.(
        `mattermost interaction: rejected callback source remote=${req.socket?.remoteAddress ?? "?"}`,
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }

    let payload: MattermostInteractionPayload;
    try {
      const raw = await readInteractionBody(req);
      payload = JSON.parse(raw) as MattermostInteractionPayload;
    } catch (err) {
      log?.(`mattermost interaction: failed to parse body: ${String(err)}`);
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const context = payload.context;
    if (!context) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing context" }));
      return;
    }

    // Verify HMAC token
    const token = context._token;
    if (typeof token !== "string") {
      log?.("mattermost interaction: missing _token in context");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing token" }));
      return;
    }

    // Strip _token before verification (it wasn't in the original context)
    const { _token, ...contextWithoutToken } = context;
    if (!verifyInteractionToken(contextWithoutToken, token, accountId)) {
      log?.("mattermost interaction: invalid _token");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }

    const actionId = context.action_id;
    if (typeof actionId !== "string") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing action_id in context" }));
      return;
    }

    const signedChannelId =
      typeof contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY] === "string"
        ? contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY].trim()
        : "";
    if (signedChannelId && signedChannelId !== payload.channel_id) {
      log?.(
        `mattermost interaction: signed channel mismatch payload=${payload.channel_id} signed=${signedChannelId}`,
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Channel mismatch" }));
      return;
    }

    const userName = payload.user_name ?? payload.user_id;
    let originalMessage = "";
    let originalPost: MattermostPost | null = null;
    let clickedButtonName: string | null = null;
    try {
      originalPost = await client.request<MattermostPost>(`/posts/${payload.post_id}`);
      const postChannelId = originalPost.channel_id?.trim();
      if (!postChannelId || postChannelId !== payload.channel_id) {
        log?.(
          `mattermost interaction: post channel mismatch payload=${payload.channel_id} post=${postChannelId ?? "<missing>"}`,
        );
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Post/channel mismatch" }));
        return;
      }
      originalMessage = originalPost.message ?? "";

      // Ensure the callback can only target an action that exists on the original post.
      const postAttachments = Array.isArray(originalPost?.props?.attachments)
        ? (originalPost.props.attachments as Array<{
            actions?: Array<{ id?: string; name?: string }>;
          }>)
        : [];
      for (const att of postAttachments) {
        const match = att.actions?.find((a) => a.id === actionId);
        if (match?.name) {
          clickedButtonName = match.name;
          break;
        }
      }
      if (clickedButtonName === null) {
        log?.(`mattermost interaction: action ${actionId} not found in post ${payload.post_id}`);
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Unknown action" }));
        return;
      }
    } catch (err) {
      log?.(`mattermost interaction: failed to validate post ${payload.post_id}: ${String(err)}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Failed to validate interaction" }));
      return;
    }

    if (!originalPost) {
      log?.(`mattermost interaction: missing fetched post ${payload.post_id}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Failed to load interaction post" }));
      return;
    }

    log?.(
      `mattermost interaction: action=${actionId} user=${payload.user_name ?? payload.user_id} ` +
        `post=${payload.post_id} channel=${payload.channel_id}`,
    );

    if (params.authorizeButtonClick) {
      try {
        const authorization = await params.authorizeButtonClick({
          payload,
          post: originalPost,
        });
        if (!authorization.ok) {
          res.statusCode = authorization.statusCode ?? 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(
              authorization.response ?? {
                ephemeral_text: "You are not allowed to use this action here.",
              },
            ),
          );
          return;
        }
      } catch (err) {
        log?.(`mattermost interaction: authorization failed: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Interaction authorization failed" }));
        return;
      }
    }

    if (params.handleInteraction) {
      try {
        const response = await params.handleInteraction({
          payload,
          userName,
          actionId,
          actionName: clickedButtonName,
          originalMessage,
          context: contextWithoutToken,
          post: originalPost,
        });
        if (response !== null) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response));
          return;
        }
      } catch (err) {
        log?.(`mattermost interaction: custom handler failed: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Interaction handler failed" }));
        return;
      }
    }

    // Dispatch as system event so the agent can handle it.
    // Wrapped in try/catch — the post update below must still run even if
    // system event dispatch fails (e.g. missing sessionKey or channel lookup).
    try {
      const eventLabel =
        `Mattermost button click: action="${actionId}" ` +
        `by ${payload.user_name ?? payload.user_id} ` +
        `in channel ${payload.channel_id}`;

      const sessionKey = params.resolveSessionKey
        ? await params.resolveSessionKey({
            channelId: payload.channel_id,
            userId: payload.user_id,
            post: originalPost,
          })
        : `agent:main:mattermost:${accountId}:${payload.channel_id}`;

      core.system.enqueueSystemEvent(eventLabel, {
        sessionKey,
        contextKey: `mattermost:interaction:${payload.post_id}:${actionId}`,
      });
    } catch (err) {
      log?.(`mattermost interaction: system event dispatch failed: ${String(err)}`);
    }

    // Update the post via API to replace buttons with a completion indicator.
    try {
      await updateMattermostPost(client, payload.post_id, {
        message: originalMessage,
        props: {
          attachments: [
            {
              text: `✓ **${clickedButtonName}** selected by @${userName}`,
            },
          ],
        },
      });
    } catch (err) {
      log?.(`mattermost interaction: failed to update post ${payload.post_id}: ${String(err)}`);
    }

    // Respond with empty JSON — the post update is handled above
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");

    // Dispatch a synthetic inbound message so the agent responds to the button click.
    if (params.dispatchButtonClick) {
      try {
        await params.dispatchButtonClick({
          channelId: payload.channel_id,
          userId: payload.user_id,
          userName,
          actionId,
          actionName: clickedButtonName,
          postId: payload.post_id,
          post: originalPost,
        });
      } catch (err) {
        log?.(`mattermost interaction: dispatchButtonClick failed: ${String(err)}`);
      }
    }
  };
}
