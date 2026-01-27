import type { Request, Response } from "express";
import {
  mergeAllowlist,
  summarizeMapping,
  type MoltbotConfig,
  type RuntimeEnv,
} from "clawdbot/plugin-sdk";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { registerMSTeamsHandlers } from "./monitor-handler.js";
import { createMSTeamsPollStoreFs, type MSTeamsPollStore } from "./polls.js";
import {
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { createMSTeamsAdapter, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";
import { getMSTeamsRuntime } from "./runtime.js";

export type MonitorMSTeamsOpts = {
  cfg: MoltbotConfig;
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
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams" });
  let cfg = opts.cfg;
  let msteamsCfg = cfg.channels?.msteams;
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

  let allowFrom = msteamsCfg.allowFrom;
  let groupAllowFrom = msteamsCfg.groupAllowFrom;
  let teamsConfig = msteamsCfg.teams;

  const cleanAllowEntry = (entry: string) =>
    entry
      .replace(/^(msteams|teams):/i, "")
      .replace(/^user:/i, "")
      .trim();

  const resolveAllowlistUsers = async (label: string, entries: string[]) => {
    if (entries.length === 0) return { additions: [], unresolved: [] };
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
    const allowEntries =
      allowFrom?.map((entry) => cleanAllowEntry(String(entry))).filter(
        (entry) => entry && entry !== "*",
      ) ?? [];
    if (allowEntries.length > 0) {
      const { additions } = await resolveAllowlistUsers("msteams users", allowEntries);
      allowFrom = mergeAllowlist({ existing: allowFrom, additions });
    }

    if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
      const groupEntries = groupAllowFrom
        .map((entry) => cleanAllowEntry(String(entry)))
        .filter((entry) => entry && entry !== "*");
      if (groupEntries.length > 0) {
        const { additions } = await resolveAllowlistUsers("msteams group users", groupEntries);
        groupAllowFrom = mergeAllowlist({ existing: groupAllowFrom, additions });
      }
    }

    if (teamsConfig && Object.keys(teamsConfig).length > 0) {
      const entries: Array<{ input: string; teamKey: string; channelKey?: string }> = [];
      for (const [teamKey, teamCfg] of Object.entries(teamsConfig)) {
        if (teamKey === "*") continue;
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
        const nextTeams = { ...(teamsConfig ?? {}) };

        resolved.forEach((entry, idx) => {
          const source = entries[idx];
          if (!source) return;
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
            ...(sourceTeam.channels ?? {}),
            ...(existing.channels ?? {}),
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
                    ...(mergedChannels?.[entry.channelId] ?? {}),
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
    runtime.log?.(`msteams resolve failed; using config entries. ${String(err)}`);
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
      .process(req, res, (context: unknown) => handler.run(context as HandlerContext))
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
