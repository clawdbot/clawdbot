import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.CLICKCLACK_FIXTURE_PORT ?? 44181);
const token = process.env.CLICKCLACK_FIXTURE_TOKEN ?? "clickclack-release-token";
const statePath = process.env.CLICKCLACK_FIXTURE_STATE ?? "/tmp/openclaw-clickclack-fixture.json";
const workspace = {
  id: "ws_release",
  name: "Release Workspace",
  slug: "release",
  created_at: new Date(0).toISOString(),
};
const channel = {
  id: "ch_general",
  workspace_id: workspace.id,
  name: "general",
  kind: "text",
  created_at: new Date(0).toISOString(),
};
const botUser = {
  id: "usr_bot",
  kind: "bot",
  display_name: "OpenClaw Bot",
  handle: "openclaw",
  avatar_url: "",
  created_at: new Date(0).toISOString(),
};
const humanUser = {
  id: "usr_human",
  kind: "human",
  display_name: "Release User",
  handle: "release-user",
  avatar_url: "",
  created_at: new Date(0).toISOString(),
};

let messageSeq = 0;
let eventSeq = 0;
const messages = [];
const threadReplies = [];
const outboundMessages = [];
const sockets = new Set();

function persist() {
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        messages,
        threadReplies,
        outboundMessages,
        socketCount: sockets.size,
      },
      null,
      2,
    )}\n`,
  );
}

function now() {
  return new Date().toISOString();
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function unauthorized(res) {
  json(res, 401, { error: "unauthorized" });
}

function checkAuth(req, res) {
  if (req.url?.startsWith("/fixture/") || req.url === "/health") {
    return true;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    unauthorized(res);
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function createMessage({ body, author = humanUser, parentMessageId }) {
  messageSeq += 1;
  const id = `msg_${messageSeq}`;
  const message = {
    id,
    workspace_id: workspace.id,
    channel_id: channel.id,
    author_id: author.id,
    ...(parentMessageId ? { parent_message_id: parentMessageId } : {}),
    thread_root_id: parentMessageId ?? id,
    channel_seq: messageSeq,
    thread_seq: parentMessageId ? threadReplies.length + 1 : 0,
    body,
    body_format: "markdown",
    created_at: now(),
    author,
  };
  if (parentMessageId) {
    threadReplies.push(message);
  } else {
    messages.push(message);
  }
  persist();
  return message;
}

function eventFor(message) {
  eventSeq += 1;
  return {
    id: `evt_${eventSeq}`,
    cursor: String(eventSeq),
    type: message.parent_message_id ? "thread.reply_created" : "message.created",
    workspace_id: workspace.id,
    channel_id: channel.id,
    seq: message.channel_seq,
    created_at: now(),
    payload: {
      message_id: message.id,
      author_id: message.author_id,
      ...(message.parent_message_id ? { root_message_id: message.thread_root_id } : {}),
    },
  };
}

function frameText(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function broadcast(event) {
  const frame = frameText(JSON.stringify(event));
  for (const socket of sockets) {
    socket.write(frame);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!checkAuth(req, res)) {
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    json(res, 200, { user: botUser });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/workspaces") {
    json(res, 200, { workspaces: [workspace] });
    return;
  }
  if (req.method === "GET" && url.pathname === `/api/workspaces/${workspace.id}/channels`) {
    json(res, 200, { channels: [channel] });
    return;
  }
  if (req.method === "GET" && url.pathname === `/api/channels/${channel.id}/messages`) {
    const afterSeq = Number(url.searchParams.get("after_seq") ?? 0);
    json(res, 200, {
      messages: messages.filter((message) => (message.channel_seq ?? 0) > afterSeq),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === `/api/channels/${channel.id}/messages`) {
    const body = await readBody(req);
    const message = createMessage({ body: String(body.body ?? ""), author: botUser });
    outboundMessages.push(message);
    persist();
    json(res, 200, { message });
    return;
  }
  const threadReplyMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/thread\/replies$/u);
  if (req.method === "POST" && threadReplyMatch) {
    const body = await readBody(req);
    const message = createMessage({
      body: String(body.body ?? ""),
      author: botUser,
      parentMessageId: decodeURIComponent(threadReplyMatch[1]),
    });
    json(res, 200, { message });
    return;
  }
  const threadMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/thread$/u);
  if (req.method === "GET" && threadMatch) {
    const rootId = decodeURIComponent(threadMatch[1]);
    json(res, 200, {
      root: messages.find((message) => message.id === rootId) ?? null,
      replies: threadReplies.filter((message) => message.thread_root_id === rootId),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/realtime/events") {
    json(res, 200, { events: [] });
    return;
  }
  if (req.method === "POST" && url.pathname === "/fixture/inbound") {
    const body = await readBody(req);
    const message = createMessage({ body: String(body.body ?? ""), author: humanUser });
    broadcast(eventFor(message));
    json(res, 200, { message });
    return;
  }
  if (req.method === "GET" && url.pathname === "/fixture/state") {
    json(res, 200, { messages, threadReplies, outboundMessages, socketCount: sockets.size });
    return;
  }
  json(res, 404, { error: `unhandled ${req.method} ${url.pathname}` });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/realtime/ws" || req.headers.authorization !== `Bearer ${token}`) {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  sockets.add(socket);
  persist();
  socket.on("close", () => {
    sockets.delete(socket);
    persist();
  });
  socket.on("error", () => {
    sockets.delete(socket);
    persist();
  });
});

persist();
server.listen(port, "127.0.0.1", () => {
  console.log(`clickclack fixture listening on ${port}`);
});
