import type { Request, Response } from "express";
import {
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  isDangerousNameMatchingEnabled,
  keepHttpServerTaskAlive,
  mergeAllowlist,
  summarizeMapping,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { registerMSTeamsHandlers, type MSTeamsActivityHandler } from "./monitor-handler.js";
import { createMSTeamsPollStoreFs, type MSTeamsPollStore } from "./polls.js";
import {
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  createBotFrameworkJwtValidator,
  createMSTeamsAdapter,
  createMSTeamsTokenProvider,
  loadMSTeamsSdkWithAuth,
} from "./sdk.js";
import { createMSTeamsSsoTokenStoreFs } from "./sso-token-store.js";
import type { MSTeamsSsoDeps } from "./sso.js";
import { resolveMSTeamsCredentials } from "./token.js";
import { applyMSTeamsWebhookTimeouts } from "./webhook-timeouts.js";

type MonitorMSTeamsOpts = {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  conversationStore?: MSTeamsConversationStore;
  pollStore?: MSTeamsPollStore;
};

type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

const MSTEAMS_WEBHOOK_MAX_BODY_BYTES = DEFAULT_WEBHOOK_MAX_BODY_BYTES;
export async function monitorMSTeamsProvider(
  opts: MonitorMSTeamsOpts,
): Promise<MonitorMSTeamsResult> {
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams" });
  let cfg = opts.cfg;
  let msteamsCfg = cfg.channels?.msteams;
  if (!msteamsCfg?.enabled) {
    log.debug?.("msteams provider disabled");
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

  let allowFrom = msteamsCfg.allowFrom;
  let groupAllowFrom = msteamsCfg.groupAllowFrom;
  let teamsConfig = msteamsCfg.teams;
  const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);

  const cleanAllowEntry = (entry: string) =>
    entry
      .replace(/^(msteams|teams):/i, "")
      .replace(/^user:/i, "")
      .trim();
  const isStableUserId = (entry: string) => /^[0-9a-fA-F-]{16,}$/.test(entry);
  const cleanAllowEntries = (entries?: string[]) =>
    entries?.map((entry) => cleanAllowEntry(entry)).filter((entry) => entry && entry !== "*") ?? [];
  const mergeStableUserIds = (entries?: string[]) => {
    const additions = cleanAllowEntries(entries).filter((entry) => isStableUserId(entry));
    return additions.length > 0 ? mergeAllowlist({ existing: entries, additions }) : entries;
  };

  const resolveAllowlistUsers = async (label: string, entries: string[]) => {
    if (entries.length === 0) {
      return { additions: [], unresolved: [] };
    }
    const resolved = await resolveMSTeamsUserAllowlist({ cfg, entries });
    const additions: string[] = [];
    const unresolved: string[] = [];
    for (const entry of resolved) {
      if (entry.resolved && entry.id) {
        additions.push(entry.id);
      } else {
        unresolved.push(entry.input);
      }
    }
    const mapping = resolved
      .filter((entry) => entry.resolved && entry.id)
      .map((entry) => `${entry.input}→${entry.id}`);
    summarizeMapping(label, mapping, unresolved, runtime);
    return { additions, unresolved };
  };

  try {
    allowFrom = mergeStableUserIds(allowFrom);
    if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
      groupAllowFrom = mergeStableUserIds(groupAllowFrom);
    }

    if (allowNameMatching) {
      const allowEntries = cleanAllowEntries(allowFrom).filter((entry) => !isStableUserId(entry));
      if (allowEntries.length > 0) {
        const { additions } = await resolveAllowlistUsers("msteams users", allowEntries);
        allowFrom = mergeAllowlist({ existing: allowFrom, additions });
      }

      if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
        const groupEntries = cleanAllowEntries(groupAllowFrom).filter(
          (entry) => !isStableUserId(entry),
        );
        if (groupEntries.length > 0) {
          const { additions } = await resolveAllowlistUsers("msteams group users", groupEntries);
          groupAllowFrom = mergeAllowlist({ existing: groupAllowFrom, additions });
        }
      }
    }

    if (teamsConfig && Object.keys(teamsConfig).length > 0) {
      const entries: Array<{ input: string; teamKey: string; channelKey?: string }> = [];
      for (const [teamKey, teamCfg] of Object.entries(teamsConfig)) {
        if (teamKey === "*") {
          continue;
        }
        const channels = teamCfg?.channels ?? {};
        const channelKeys = Object.keys(channels).filter((key) => key !== "*");
        if (channelKeys.length === 0) {
          entries.push({ input: teamKey, teamKey });
          continue;
        }
        for (const channelKey of channelKeys) {
          entries.push({
            input: `${teamKey}/${channelKey}`,
            teamKey,
            channelKey,
          });
        }
      }

      if (entries.length > 0) {
        const resolved = await resolveMSTeamsChannelAllowlist({
          cfg,
          entries: entries.map((entry) => entry.input),
        });
        const mapping: string[] = [];
        const unresolved: string[] = [];
        const nextTeams = { ...teamsConfig };

        resolved.forEach((entry, idx) => {
          const source = entries[idx];
          if (!source) {
            return;
          }
          const sourceTeam = teamsConfig?.[source.teamKey] ?? {};
          if (!entry.resolved || !entry.teamId) {
            unresolved.push(entry.input);
            return;
          }
          mapping.push(
            entry.channelId
              ? `${entry.input}→${entry.teamId}/${entry.channelId}`
              : `${entry.input}→${entry.teamId}`,
          );
          const existing = nextTeams[entry.teamId] ?? {};
          const mergedChannels = {
            ...sourceTeam.channels,
            ...existing.channels,
          };
          const mergedTeam = { ...sourceTeam, ...existing, channels: mergedChannels };
          nextTeams[entry.teamId] = mergedTeam;
          if (source.channelKey && entry.channelId) {
            const sourceChannel = sourceTeam.channels?.[source.channelKey];
            if (sourceChannel) {
              nextTeams[entry.teamId] = {
                ...mergedTeam,
                channels: {
                  ...mergedChannels,
                  [entry.channelId]: {
                    ...sourceChannel,
                    ...mergedChannels?.[entry.channelId],
                  },
                },
              };
            }
          }
        });

        teamsConfig = nextTeams;
        summarizeMapping("msteams channels", mapping, unresolved, runtime);
      }
    }
  } catch (err) {
    // Log at error (not log) — allowlist resolution failures leave the bot in a
    // degraded state where Graph-resolved IDs are missing (#77674).
    runtime?.error(
      `msteams resolve failed; falling back to raw config entries — allowlist members resolved via Graph may be missing. ${formatUnknownError(err)}`,
    );
  }

  msteamsCfg = {
    ...msteamsCfg,
    allowFrom,
    groupAllowFrom,
    teams: teamsConfig,
  };
  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: msteamsCfg,
    },
  };

  const port = msteamsCfg.webhook?.port ?? 3978;
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "msteams");
  const MB = 1024 * 1024;
  const agentDefaults = cfg.agents?.defaults;
  const mediaMaxBytes =
    typeof agentDefaults?.mediaMaxMb === "number" && agentDefaults.mediaMaxMb > 0
      ? Math.floor(agentDefaults.mediaMaxMb * MB)
      : 8 * MB;
  const conversationStore = opts.conversationStore ?? createMSTeamsConversationStoreFs();
  const pollStore = opts.pollStore ?? createMSTeamsPollStoreFs();

  log.info(`starting provider (port ${port})`);

  // Dynamic import to avoid loading SDK when provider is disabled
  const express = await import("express");

  const { sdk, app } = await loadMSTeamsSdkWithAuth(creds);

  // Build a token provider adapter for Graph API operations
  const tokenProvider = createMSTeamsTokenProvider(app);

  const adapter = createMSTeamsAdapter(app, sdk);

  // Build SSO deps when the operator has opted in and a connection name
  // is configured. Leaving `sso` undefined matches the pre-SSO behavior
  // (the plugin will still ack signin invokes, but will not attempt a
  // Bot Framework token exchange or persist anything).
  let ssoDeps: MSTeamsSsoDeps | undefined;
  if (msteamsCfg.sso?.enabled && msteamsCfg.sso.connectionName) {
    ssoDeps = {
      tokenProvider,
      tokenStore: createMSTeamsSsoTokenStoreFs(),
      connectionName: msteamsCfg.sso.connectionName,
    };
    log.debug?.("msteams sso enabled", {
      connectionName: msteamsCfg.sso.connectionName,
    });
  }

  // Build a simple ActivityHandler-compatible object
  const handler = buildActivityHandler();
  registerMSTeamsHandlers(handler, {
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
    sso: ssoDeps,
  });

  // Create Express server
  const expressApp = express.default();

  // Cheap pre-parse auth gate: reject requests without a Bearer token before
  // spending CPU/memory on JSON body parsing. This prevents unauthenticated
  // request floods from forcing body parsing on internet-exposed webhooks.
  expressApp.use((req: Request, res: Response, next: (err?: unknown) => void) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  // JWT validation — verify Bot Framework tokens using the Teams SDK's
  // JwtValidator (validates signature via JWKS, audience, issuer, expiration).
  const jwtValidator = await createBotFrameworkJwtValidator(creds);
  expressApp.use((req: Request, res: Response, next: (err?: unknown) => void) => {
    // Authorization header is guaranteed by the pre-parse auth gate above.
    // `serviceUrl` is optional, so authenticate from headers alone before body
    // I/O to avoid spending memory and CPU on unauthenticated requests.
    const authHeader = req.headers.authorization!;
    jwtValidator
      .validate(authHeader)
      .then((valid) => {
        if (!valid) {
          log.debug?.("JWT validation failed");
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        next();
      })
      .catch((err) => {
        // Network-level failures (DNS, firewall, TLS toward login.botframework.com)
        // are rethrown by the validator so we can log them visibly. Without this,
        // they look identical to a bad credential at default log levels (#77674).
        const isNetworkFailure =
          err instanceof Error &&
          /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/i.test(
            (err as NodeJS.ErrnoException).code ?? err.message,
          );
        if (isNetworkFailure) {
          // Network failure fetching JWKS keys — log visibly so operators can
          // identify egress blocks to login.botframework.com (#77674).
          runtime?.error(
            `msteams: JWKS key fetch failed — check egress to login.botframework.com:443 (firewall or DNS may be blocking it). Bot will 401 all inbound requests until this is resolved. Error: ${formatUnknownError(err)}`,
          );
        } else {
          log.debug?.(`JWT validation error: ${formatUnknownError(err)}`);
        }
        res.status(401).json({ error: "Unauthorized" });
      });
  });

  expressApp.use(express.json({ limit: MSTEAMS_WEBHOOK_MAX_BODY_BYTES }));
  expressApp.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
    if (err && typeof err === "object" && "status" in err && err.status === 413) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }
    next(err);
  });

  // Set up the messages endpoint - use configured path and /api/messages as fallback
  const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
  const messageHandler = (req: Request, res: Response) => {
    void adapter
      .process(req, res, (context: unknown) => handler.run!(context))
      .catch((err: unknown) => {
        log.error("msteams webhook failed", { error: formatUnknownError(err) });
      });
  };

  // Listen on configured path and /api/messages (standard Bot Framework path)
  expressApp.post(configuredPath, messageHandler);
  if (configuredPath !== "/api/messages") {
    expressApp.post("/api/messages", messageHandler);
  }

  log.debug?.("listening on paths", {
    primary: configuredPath,
    fallback: "/api/messages",
  });

  // Start listening and fail fast if bind/listen fails.
  const httpServer = expressApp.listen(port);
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      httpServer.off("error", onError);
      log.info(`msteams provider started on port ${port}`);
      resolve();
    };
    const onError = (err: unknown) => {
      httpServer.off("listening", onListening);
      log.error("msteams server error", { error: formatUnknownError(err) });
      reject(err);
    };
    httpServer.once("listening", onListening);
    httpServer.once("error", onError);
  });
  applyMSTeamsWebhookTimeouts(httpServer);

  httpServer.on("error", (err) => {
    log.error("msteams server error", { error: formatUnknownError(err) });
  });

  const shutdown = async () => {
    log.info("shutting down msteams provider");
    return new Promise<void>((resolve) => {
      httpServer.close((err) => {
        if (err) {
          log.debug?.("msteams server close error", { error: formatUnknownError(err) });
        }
        resolve();
      });
    });
  };

  // Keep this task alive until close so gateway runtime does not treat startup as exit.
  await keepHttpServerTaskAlive({
    server: httpServer,
    abortSignal: opts.abortSignal,
    onAbort: shutdown,
  });

  return { app: expressApp, shutdown };
}

/**
 * Build a minimal ActivityHandler-compatible object that supports
 * onMessage / onMembersAdded registration and a run() method.
 */
function buildActivityHandler(): MSTeamsActivityHandler {
  type Handler = (context: unknown, next: () => Promise<void>) => Promise<void>;
  const messageHandlers: Handler[] = [];
  const membersAddedHandlers: Handler[] = [];
  const reactionsAddedHandlers: Handler[] = [];
  const reactionsRemovedHandlers: Handler[] = [];

  const handler: MSTeamsActivityHandler = {
    onMessage(cb) {
      messageHandlers.push(cb);
      return handler;
    },
    onMembersAdded(cb) {
      membersAddedHandlers.push(cb);
      return handler;
    },
    onReactionsAdded(cb) {
      reactionsAddedHandlers.push(cb);
      return handler;
    },
    onReactionsRemoved(cb) {
      reactionsRemovedHandlers.push(cb);
      return handler;
    },
    async run(context: unknown) {
      const ctx = context as { activity?: { type?: string } };
      const activityType = ctx?.activity?.type;
      const noop = async () => {};

      if (activityType === "message") {
        for (const h of messageHandlers) {
          await h(context, noop);
        }
      } else if (activityType === "conversationUpdate") {
        for (const h of membersAddedHandlers) {
          await h(context, noop);
        }
      } else if (activityType === "messageReaction") {
        const activity = (
          ctx as { activity?: { reactionsAdded?: unknown[]; reactionsRemoved?: unknown[] } }
        )?.activity;
        if (activity?.reactionsAdded?.length) {
          for (const h of reactionsAddedHandlers) {
            await h(context, noop);
          }
        }
        if (activity?.reactionsRemoved?.length) {
          for (const h of reactionsRemovedHandlers) {
            await h(context, noop);
          }
        }
      }
    },
  };

  return handler;
}
