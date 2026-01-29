import type { Request, Response } from "express";
import type { MoltbotConfig, RuntimeEnv } from "clawdbot/plugin-sdk";

import type { ZoomConversationStore } from "./conversation-store.js";
import { createZoomConversationStoreFs } from "./conversation-store-fs.js";
import { formatUnknownError } from "./errors.js";
import { createZoomMessageHandler } from "./monitor-handler.js";
import type { ZoomMonitorLogger } from "./monitor-types.js";
import { resolveZoomCredentials } from "./token.js";
import type { ZoomConfig, ZoomCredentials } from "./types.js";
import { handleZoomChallenge, verifyZoomWebhook } from "./webhook.js";
import { getZoomRuntime } from "./runtime.js";

export type MonitorZoomOpts = {
  cfg: MoltbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  conversationStore?: ZoomConversationStore;
};

export type MonitorZoomResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

export async function monitorZoomProvider(
  opts: MonitorZoomOpts,
): Promise<MonitorZoomResult> {
  const core = getZoomRuntime();
  const log = core.logging.getChildLogger({ name: "zoom" });
  const cfg = opts.cfg;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;

  if (!zoomCfg?.enabled) {
    log.debug("zoom provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveZoomCredentials(zoomCfg);
  if (!creds) {
    log.error("zoom credentials not configured");
    return { app: null, shutdown: async () => {} };
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const port = zoomCfg.webhook?.port ?? 4000;
  const webhookPath = zoomCfg.webhook?.path ?? "/zoom/webhook";
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zoom");
  const conversationStore = opts.conversationStore ?? createZoomConversationStoreFs();

  log.info(`starting provider (port ${port})`);

  // Dynamic import to avoid loading express when provider is disabled
  const express = await import("express");

  const expressApp = express.default();

  // Custom body parser to get raw body for signature verification
  expressApp.use(
    webhookPath,
    express.json({
      verify: (req: Request, _res: Response, buf: Buffer) => {
        // Store raw body for signature verification
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  // Also add general JSON parser for other routes
  expressApp.use(express.json());

  const handleMessage = createZoomMessageHandler({
    cfg,
    runtime,
    creds,
    textLimit,
    conversationStore,
    log: log as ZoomMonitorLogger,
  });

  // Webhook endpoint
  expressApp.post(webhookPath, async (req: Request, res: Response) => {
    try {
      const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
      const signature = req.headers["x-zm-signature"] as string | undefined;
      const timestamp = req.headers["x-zm-request-timestamp"] as string | undefined;

      // Handle URL validation challenge
      if (req.body?.event === "endpoint.url_validation") {
        const plainToken = req.body.payload?.plainToken;
        if (plainToken && creds.webhookSecretToken) {
          const challenge = handleZoomChallenge({
            plainToken,
            secret: creds.webhookSecretToken,
          });
          log.debug("responding to URL validation challenge");
          res.status(200).json(challenge);
          return;
        }
        log.warn("URL validation received but missing plainToken or secret");
        res.status(400).json({ error: "missing challenge data" });
        return;
      }

      // Verify webhook signature if secret is configured
      if (creds.webhookSecretToken) {
        if (!signature || !timestamp) {
          log.warn("missing webhook signature headers");
          res.status(401).json({ error: "missing signature" });
          return;
        }

        const valid = verifyZoomWebhook({
          payload: rawBody,
          signature,
          timestamp,
          secret: creds.webhookSecretToken,
        });

        if (!valid) {
          log.warn("invalid webhook signature");
          res.status(401).json({ error: "invalid signature" });
          return;
        }
      }

      // Acknowledge webhook immediately
      res.status(200).json({ status: "ok" });

      // Process message asynchronously
      await handleMessage(req.body);
    } catch (err) {
      log.error("webhook handler failed", { error: formatUnknownError(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: "internal error" });
      }
    }
  });

  // Health check endpoint
  expressApp.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", channel: "zoom" });
  });

  log.debug("listening on path", { path: webhookPath });

  // Return a promise that stays pending until shutdown
  return new Promise<MonitorZoomResult>((resolve) => {
    const httpServer = expressApp.listen(port, () => {
      log.info(`zoom provider started on port ${port}`);
    });

    httpServer.on("error", (err) => {
      log.error("zoom server error", { error: String(err) });
    });

    const shutdown = async () => {
      log.info("shutting down zoom provider");
      return new Promise<void>((resolveShutdown) => {
        httpServer.close((err) => {
          if (err) {
            log.debug("zoom server close error", { error: String(err) });
          }
          resolveShutdown();
          resolve({ app: expressApp, shutdown });
        });
      });
    };

    // Handle abort signal - this is the only way the provider stops
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => {
        void shutdown();
      });
    }
  });
}
