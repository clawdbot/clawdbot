import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type MSTeamsQaOutboundActivity = {
  activity: Record<string, unknown>;
  activityId: string;
  conversationId: string;
  threadId?: string;
};

type ServerOptions = {
  botToken: string;
  nonce: string;
  onOutbound: (activity: MSTeamsQaOutboundActivity) => Promise<void>;
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function parseConversationPath(pathname: string) {
  const match = /\/v3\/conversations\/([^/]+)\/activities(?:\/[^/]+)?$/u.exec(pathname);
  if (!match) {
    return undefined;
  }
  const encodedConversationId = match[1];
  if (!encodedConversationId) {
    return undefined;
  }
  const rawConversationId = decodeURIComponent(encodedConversationId);
  const [conversationId, threadId] = rawConversationId.split(";messageid=", 2);
  if (!conversationId) {
    return undefined;
  }
  return { conversationId, threadId };
}

export async function startMSTeamsQaBotFrameworkServer(options: ServerOptions) {
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.headers["x-openclaw-msteams-qa-nonce"] !== options.nonce ||
        request.headers.authorization !== `Bearer ${options.botToken}`
      ) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = parseConversationPath(url.pathname);
      if (request.method !== "POST" || !route) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const activity = await readJson(request);
      const activityId = `qa-outbound-${randomUUID()}`;
      await options.onOutbound({
        activity,
        activityId,
        conversationId: route.conversationId,
        ...(route.threadId ? { threadId: route.threadId } : {}),
      });
      sendJson(response, 200, { id: activityId });
    })().catch((error: unknown) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

export async function reserveMSTeamsQaWebhookPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}
