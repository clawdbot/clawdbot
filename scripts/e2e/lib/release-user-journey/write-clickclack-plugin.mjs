#!/usr/bin/env node
// Writes the external ClickClack channel fixture used by release journey E2Es.
import fs from "node:fs";
import path from "node:path";

const pluginDir = process.argv[2];
if (!pluginDir) {
  console.error("usage: write-clickclack-plugin.mjs <plugin-dir>");
  process.exit(2);
}

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(
  path.join(pluginDir, "package.json"),
  `${JSON.stringify(
    {
      name: "clickclack",
      version: "0.0.1",
      type: "module",
      openclaw: {
        extensions: ["./index.mjs"],
        channel: {
          id: "clickclack",
          configuredState: { env: { anyOf: ["CLICKCLACK_BOT_TOKEN"] } },
        },
      },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  `${JSON.stringify(
    {
      id: "clickclack",
      activation: { onStartup: false },
      channels: ["clickclack"],
      channelConfigs: {
        clickclack: {
          schema: {
            type: "object",
            additionalProperties: true,
            properties: {
              enabled: { type: "boolean", default: true },
              baseUrl: { type: "string" },
              workspace: { type: "string" },
              defaultTo: { type: "string" },
              token: {},
            },
          },
        },
      },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    null,
    2,
  )}\n`,
);

fs.writeFileSync(
  path.join(pluginDir, "index.mjs"),
  `import crypto from "node:crypto";
import net from "node:net";

const CHANNEL_ID = "clickclack";
const DEFAULT_ACCOUNT_ID = "default";

function configFor(cfg) {
  return cfg?.channels?.clickclack ?? {};
}

function readToken(raw) {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (raw && typeof raw === "object" && raw.source === "env" && typeof raw.id === "string") {
    return String(process.env[raw.id] ?? "").trim();
  }
  return String(process.env.CLICKCLACK_BOT_TOKEN ?? "").trim();
}

function resolveAccount(cfg, accountId = DEFAULT_ACCOUNT_ID) {
  const config = configFor(cfg);
  const token = readToken(config.token);
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    enabled: config.enabled !== false,
    configured: Boolean(baseUrl && token),
    baseUrl,
    token,
    workspace: typeof config.workspace === "string" && config.workspace ? config.workspace : "release",
    defaultTo: typeof config.defaultTo === "string" ? config.defaultTo : "channel:general",
    reconnectMs: Number.isFinite(config.reconnectMs) ? Math.max(50, Number(config.reconnectMs)) : 250,
  };
}

async function requestJson(account, method, pathname, body) {
  const response = await fetch(new URL(pathname, account.baseUrl), {
    method,
    headers: {
      authorization: \`Bearer \${account.token}\`,
      ...(body == null ? {} : { "content-type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(\`ClickClack fixture \${response.status}: \${await response.text()}\`);
  }
  return await response.json();
}

async function resolveWorkspaceId(account) {
  const data = await requestJson(account, "GET", "/api/workspaces");
  const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
  const match = workspaces.find((workspace) =>
    workspace?.id === account.workspace ||
    workspace?.slug === account.workspace ||
    workspace?.name === account.workspace
  );
  if (!match?.id) {
    throw new Error(\`ClickClack workspace not found: \${account.workspace}\`);
  }
  return match.id;
}

async function resolveChannelId(account, workspaceId, rawTarget) {
  const target = String(rawTarget ?? "").trim();
  const channelName = target.startsWith("channel:") ? target.slice("channel:".length) : target;
  const data = await requestJson(account, "GET", \`/api/workspaces/\${encodeURIComponent(workspaceId)}/channels\`);
  const channels = Array.isArray(data.channels) ? data.channels : [];
  const match = channels.find((channel) => channel?.id === channelName || channel?.name === channelName);
  if (!match?.id) {
    throw new Error(\`ClickClack channel not found: \${channelName}\`);
  }
  return match.id;
}

async function sendText(cfg, to, text, accountId, threadId, replyToId) {
  const account = resolveAccount(cfg, accountId);
  if (!account.configured) {
    throw new Error("ClickClack is not configured");
  }
  const workspaceId = await resolveWorkspaceId(account);
  const rootId = threadId == null ? String(replyToId ?? "") : String(threadId);
  if (rootId) {
    const data = await requestJson(
      account,
      "POST",
      \`/api/messages/\${encodeURIComponent(rootId)}/thread/replies\`,
      { body: text },
    );
    return data.message;
  }
  const channelId = await resolveChannelId(account, workspaceId, to);
  const data = await requestJson(account, "POST", \`/api/channels/\${encodeURIComponent(channelId)}/messages\`, {
    body: text,
  });
  return data.message;
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) {
      return null;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  return {
    opcode,
    text: buffer.subarray(offset, offset + length).toString("utf8"),
    rest: buffer.subarray(offset + length),
  };
}

function openEventSocket(account, workspaceId, afterCursor, onEvent, signal) {
  const base = new URL(account.baseUrl);
  const key = crypto.randomBytes(16).toString("base64");
  const socket = net.createConnection({
    host: base.hostname,
    port: Number(base.port || (base.protocol === "https:" ? 443 : 80)),
  });
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const close = () => socket.destroy();
  signal.addEventListener("abort", close, { once: true });
  socket.on("connect", () => {
    const query = new URLSearchParams({ workspace_id: workspaceId });
    if (afterCursor) {
      query.set("after_cursor", afterCursor);
    }
    socket.write(
      [
        \`GET /api/realtime/ws?\${query.toString()} HTTP/1.1\`,
        \`Host: \${base.host}\`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        \`Sec-WebSocket-Key: \${key}\`,
        "Sec-WebSocket-Version: 13",
        \`Authorization: Bearer \${account.token}\`,
        "",
        "",
      ].join("\\r\\n"),
    );
  });
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
      if (headerEnd === -1) {
        return;
      }
      const headers = buffer.subarray(0, headerEnd).toString("utf8");
      if (!headers.startsWith("HTTP/1.1 101")) {
        socket.destroy(new Error(headers.split("\\r\\n")[0] || "websocket upgrade failed"));
        return;
      }
      upgraded = true;
      buffer = buffer.subarray(headerEnd + 4);
    }
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) {
        return;
      }
      buffer = frame.rest;
      if (frame.opcode === 1) {
        onEvent(JSON.parse(frame.text));
      } else if (frame.opcode === 8) {
        socket.end();
        return;
      }
    }
  });
  socket.on("close", () => signal.removeEventListener("abort", close));
  return socket;
}

async function resolveEventMessage(account, event) {
  if (event?.type !== "message.created" || !event.channel_id || typeof event.seq !== "number") {
    return null;
  }
  const data = await requestJson(
    account,
    "GET",
    \`/api/channels/\${encodeURIComponent(event.channel_id)}/messages?after_seq=\${Math.max(0, event.seq - 1)}\`,
  );
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return messages.find((message) => message?.id === event.payload?.message_id) ?? null;
}

async function dispatchInbound(ctx, account, message) {
  const runtime = ctx.channelRuntime;
  if (!runtime) {
    throw new Error("ClickClack fixture requires channel runtime");
  }
  const target = \`channel:\${message.channel_id}\`;
  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "channel", id: target },
  });
  const storePath = runtime.session.resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const senderName = message.author?.display_name || message.author_id || "Release User";
  const body = runtime.reply.formatAgentEnvelope({
    channel: "ClickClack",
    from: senderName,
    timestamp: new Date(message.created_at),
    previousTimestamp,
    envelope: runtime.reply.resolveEnvelopeFormatOptions(ctx.cfg),
    body: message.body,
  });
  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: message.body,
    RawBody: message.body,
    CommandBody: message.body,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? account.accountId,
    ChatType: "group",
    WasMentioned: true,
    ConversationLabel: message.channel_id,
    GroupChannel: message.channel_id,
    NativeChannelId: message.channel_id,
    MessageSid: message.id,
    MessageSidFull: message.id,
    ReplyToId: message.id,
    Timestamp: message.created_at,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: target,
    CommandAuthorized: true,
  });
  await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = payload && typeof payload === "object" ? String(payload.text ?? "") : "";
        if (text.trim()) {
          await sendText(ctx.cfg, target, text, account.accountId, message.id, message.id);
        }
      },
      onError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
  });
}

const clickclackPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "ClickClack",
    selectionLabel: "ClickClack",
    docsPath: "/channels/clickclack",
    blurb: "Release journey ClickClack fixture.",
  },
  capabilities: { chatTypes: ["group"], threads: true },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    resolveAccount,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
    resolveDefaultTo: ({ cfg }) => resolveAccount(cfg).defaultTo,
  },
  status: {
    buildChannelSummary: ({ snapshot }) => ({
      ok: snapshot.configured === true,
      label: snapshot.configured ? "configured" : "missing config",
      detail: snapshot.baseUrl ?? "",
    }),
    buildAccountSnapshot: ({ account }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const message = await sendText(ctx.cfg, ctx.to, ctx.text, ctx.accountId, ctx.threadId, ctx.replyToId);
      return { channel: CHANNEL_ID, messageId: message.id };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = resolveAccount(ctx.cfg, ctx.account.accountId);
      if (!account.configured) {
        throw new Error("ClickClack is not configured");
      }
      const workspaceId = await resolveWorkspaceId(account);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        configured: true,
        enabled: account.enabled,
        baseUrl: account.baseUrl,
      });
      try {
        while (!ctx.abortSignal.aborted) {
          const socket = openEventSocket(
            account,
            workspaceId,
            "",
            (event) => {
              void (async () => {
                const message = await resolveEventMessage(account, event);
                if (message && message.author?.kind !== "bot") {
                  await dispatchInbound(ctx, account, message);
                }
              })().catch((error) => {
                ctx.log?.error?.(error instanceof Error ? error.message : String(error));
              });
            },
            ctx.abortSignal,
          );
          await new Promise((resolve) => {
            socket.once("close", resolve);
            socket.once("error", resolve);
          });
          if (!ctx.abortSignal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, account.reconnectMs));
          }
        }
      } finally {
        ctx.setStatus({ accountId: account.accountId, running: false });
      }
    },
  },
};

export default {
  id: CHANNEL_ID,
  register(api) {
    api.registerChannel({ plugin: clickclackPlugin });
  },
};
`,
);
