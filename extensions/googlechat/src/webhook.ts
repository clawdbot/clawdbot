import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RuntimeEnv } from "clawdbot/plugin-sdk";
import type { GoogleChatEvent } from "./types.js";
import { getGoogleChatRuntime } from "./runtime.js";

const DEFAULT_WEBHOOK_PORT = 8790;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/google-chat-webhook";
const HEALTH_PATH = "/healthz";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

function parseWebhookPayload(body: string): GoogleChatEvent | null {
  try {
    const data = JSON.parse(body);
    if (!data.type) {
      return null;
    }
    return data as GoogleChatEvent;
  } catch {
    return null;
  }
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export type GoogleChatWebhookServerOptions = {
  port: number;
  host: string;
  path: string;
  onMessage: (event: GoogleChatEvent) => void | Promise<void>;
  onError?: (error: Error) => void;
  abortSignal?: AbortSignal;
};

export function createGoogleChatWebhookServer(opts: GoogleChatWebhookServerOptions): {
  server: Server;
  start: () => Promise<void>;
  stop: () => void;
} {
  const { port, host, path, onMessage, onError, abortSignal } = opts;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check endpoint
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // Only accept POST requests to the webhook path
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const body = await readBody(req);

      // Parse the Google Chat webhook payload
      const event = parseWebhookPayload(body);
      if (!event) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payload format" }));
        return;
      }

      // Google Chat expects a 200 response immediately
      // We'll process the event asynchronously
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));

      // Process the event
      try {
        await onMessage(event);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(formatError(err)));
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(formatError(err));
      onError?.(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve());
    });
  };

  const stop = () => {
    server.close();
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", stop, { once: true });
  }

  return { server, start, stop };
}

export type GoogleChatWebhookMonitorOptions = {
  accountId: string;
  config: any;
  webhookPort?: number;
  webhookHost?: string;
  webhookPath?: string;
  webhookPublicUrl?: string;
  onMessage: (event: GoogleChatEvent) => void | Promise<void>;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export async function monitorGoogleChatWebhook(
  opts: GoogleChatWebhookMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getGoogleChatRuntime();
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (message: string) => core.logging.getChildLogger().info(message),
    error: (message: string) => core.logging.getChildLogger().error(message),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  const port = opts.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const host = opts.webhookHost ?? DEFAULT_WEBHOOK_HOST;
  const path = opts.webhookPath ?? DEFAULT_WEBHOOK_PATH;

  const logger = core.logging.getChildLogger({
    channel: "googlechat",
    accountId: opts.accountId,
  });

  const { start, stop } = createGoogleChatWebhookServer({
    port,
    host,
    path,
    onMessage: async (event) => {
      await opts.onMessage(event);
    },
    onError: (error) => {
      logger.error(`[googlechat:${opts.accountId}] webhook error: ${error.message}`);
    },
    abortSignal: opts.abortSignal,
  });

  await start();

  const publicUrl =
    opts.webhookPublicUrl ??
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
  logger.info(`[googlechat:${opts.accountId}] webhook listening on ${publicUrl}`);

  return { stop };
}
