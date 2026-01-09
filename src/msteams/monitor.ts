import type { Request, Response } from "express";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import type { ClawdbotConfig } from "../config/types.js";
import { getChildLogger } from "../logging.js";
import type { RuntimeEnv } from "../runtime.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { registerMSTeamsHandlers } from "./monitor-handler.js";
import { createMSTeamsPollStoreFs, type MSTeamsPollStore } from "./polls.js";
import { createMSTeamsAdapter, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

const log = getChildLogger({ name: "msteams" });

export type MonitorMSTeamsOpts = {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  conversationStore?: MSTeamsConversationStore;
  pollStore?: MSTeamsPollStore;
};

export type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

export async function monitorMSTeamsProvider(
  opts: MonitorMSTeamsOpts,
): Promise<MonitorMSTeamsResult> {
  const cfg = opts.cfg;
  const msteamsCfg = cfg.msteams;
  if (!msteamsCfg?.enabled) {
    log.debug("msteams provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    log.error("msteams credentials not configured");
    return { app: null, shutdown: async () => {} };
  }
  const appId = creds.appId; // Extract for use in closures

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const port = msteamsCfg.webhook?.port ?? 3978;
  const textLimit = resolveTextChunkLimit(cfg, "msteams");
  const MB = 1024 * 1024;
  const agentDefaults = cfg.agents?.defaults;
  const mediaMaxBytes =
    typeof agentDefaults?.mediaMaxMb === "number" &&
    agentDefaults.mediaMaxMb > 0
      ? Math.floor(agentDefaults.mediaMaxMb * MB)
      : 8 * MB;
  const conversationStore =
    opts.conversationStore ?? createMSTeamsConversationStoreFs();
  const pollStore = opts.pollStore ?? createMSTeamsPollStoreFs();

  log.info(`starting provider (port ${port})`);

  // Dynamic import to avoid loading SDK when provider is disabled
  const express = await import("express");

  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  const { ActivityHandler, MsalTokenProvider, authorizeJWT } = sdk;

  // Auth configuration - create early so adapter is available for deliverReplies
  const tokenProvider = new MsalTokenProvider(authConfig);
  const adapter = createMSTeamsAdapter(authConfig, sdk);

  const handler = registerMSTeamsHandlers(new ActivityHandler(), {
    cfg,
    runtime,
    appId,
    adapter: adapter as unknown as MSTeamsAdapter,
    tokenProvider,
    textLimit,
    mediaMaxBytes,
    conversationStore,
    pollStore,
    log,
  });

  // Create Express server
  const expressApp = express.default();
  expressApp.use(express.json());
  expressApp.use(authorizeJWT(authConfig));

  // Set up the messages endpoint - use configured path and /api/messages as fallback
  const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
  const messageHandler = (req: Request, res: Response) => {
    type HandlerContext = Parameters<(typeof handler)["run"]>[0];
    void adapter
      .process(req, res, (context: unknown) =>
        handler.run(context as HandlerContext),
      )
      .catch((err: unknown) => {
        log.error("msteams webhook failed", { error: formatUnknownError(err) });
      });
  };

  // Listen on configured path and /api/messages (standard Bot Framework path)
  expressApp.post(configuredPath, messageHandler);
  if (configuredPath !== "/api/messages") {
    expressApp.post("/api/messages", messageHandler);
  }

  log.debug("listening on paths", {
    primary: configuredPath,
    fallback: "/api/messages",
  });

  // Start listening and capture the HTTP server handle
  const httpServer = expressApp.listen(port, () => {
    log.info(`msteams provider started on port ${port}`);
  });

  httpServer.on("error", (err) => {
    log.error("msteams server error", { error: String(err) });
  });

  const shutdown = async () => {
    log.info("shutting down msteams provider");
    return new Promise<void>((resolve) => {
      httpServer.close((err) => {
        if (err) {
          log.debug("msteams server close error", { error: String(err) });
        }
        resolve();
      });
    });
  };

  // Handle abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => {
      void shutdown();
    });
  }

  return { app: expressApp, shutdown };
}
