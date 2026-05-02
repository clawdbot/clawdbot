/**
 * Shared state for Mattermost slash commands.
 *
 * Bridges the plugin registration phase (HTTP route) with the monitor phase
 * (command registration with MM API). The HTTP handler needs to know which
 * tokens are known for fast-path routing, and the monitor needs to store
 * registered command IDs.
 *
 * State is kept per-account so that multi-account deployments don't
 * overwrite each other's tokens, registered commands, or handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { MattermostConfig } from "../types.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  type OpenClawPluginApi,
} from "./runtime-api.js";
import {
  normalizeSlashCommandTrigger,
  parseSlashCommandPayload,
  resolveSlashCommandConfig,
  type MattermostRegisteredCommand,
} from "./slash-commands.js";
import {
  clearMattermostSlashCommandValidationCacheForAccount,
  createSlashCommandHttpHandler,
} from "./slash-http.js";

const MULTI_ACCOUNT_BODY_MAX_BYTES = 64 * 1024;
const MULTI_ACCOUNT_BODY_TIMEOUT_MS = 5_000;
type SlashHandlerMatchSource = "token" | "command";
type SlashHandlerMatch =
  | { kind: "none" }
  | {
      kind: "single";
      source: SlashHandlerMatchSource;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      accountIds: string[];
    }
  | {
      kind: "ambiguous";
      source: SlashHandlerMatchSource;
      accountIds: string[];
    };

// ─── Per-account state ───────────────────────────────────────────────────────

type SlashCommandAccountState = {
  /** Tokens from registered/current commands, used for fast-path routing. */
  commandTokens: Set<string>;
  /** Registered command IDs for cleanup on shutdown. */
  registeredCommands: MattermostRegisteredCommand[];
  /** Current HTTP handler for this account. */
  handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null;
  /** The account that activated slash commands. */
  account: ResolvedMattermostAccount;
  /** Map from trigger to original command name (for skill commands that start with oc_). */
  triggerMap: Map<string, string>;
};

/** Map from accountId → per-account slash command state. */
const accountStates = new Map<string, SlashCommandAccountState>();

export function resolveSlashHandlerForToken(token: string): SlashHandlerMatch {
  const matches: Array<{
    accountId: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }> = [];

  for (const [accountId, state] of accountStates) {
    if (state.commandTokens.has(token) && state.handler) {
      matches.push({ accountId, handler: state.handler });
    }
  }

  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length === 1) {
    return {
      kind: "single",
      source: "token",
      handler: matches[0].handler,
      accountIds: [matches[0].accountId],
    };
  }

  return {
    kind: "ambiguous",
    source: "token",
    accountIds: matches.map((entry) => entry.accountId),
  };
}

export function resolveSlashHandlerForCommand(params: {
  teamId: string;
  command: string;
}): SlashHandlerMatch {
  const trigger = normalizeSlashCommandTrigger(params.command);
  if (!trigger) {
    return { kind: "none" };
  }

  const matches: Array<{
    accountId: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }> = [];

  for (const [accountId, state] of accountStates) {
    if (
      state.handler &&
      state.registeredCommands.some(
        (cmd) => cmd.teamId === params.teamId && cmd.trigger === trigger,
      )
    ) {
      matches.push({ accountId, handler: state.handler });
    }
  }

  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length === 1) {
    return {
      kind: "single",
      source: "command",
      handler: matches[0].handler,
      accountIds: [matches[0].accountId],
    };
  }

  return {
    kind: "ambiguous",
    source: "command",
    accountIds: matches.map((entry) => entry.accountId),
  };
}

/**
 * Get the slash command state for a specific account, or null if not activated.
 */
export function getSlashCommandState(accountId: string): SlashCommandAccountState | null {
  return accountStates.get(accountId) ?? null;
}

/**
 * Activate slash commands for a specific account.
 * Called from the monitor after bot connects.
 */
export function activateSlashCommands(params: {
  account: ResolvedMattermostAccount;
  commandTokens: string[];
  registeredCommands: MattermostRegisteredCommand[];
  triggerMap?: Map<string, string>;
  api: {
    cfg: import("./runtime-api.js").OpenClawConfig;
    runtime: import("./runtime-api.js").RuntimeEnv;
  };
  log?: (msg: string) => void;
}) {
  const { account, commandTokens, registeredCommands, triggerMap, api, log } = params;
  const accountId = account.accountId;

  const tokenSet = new Set(commandTokens);

  const handler = createSlashCommandHttpHandler({
    account,
    cfg: api.cfg,
    runtime: api.runtime,
    registeredCommands,
    triggerMap,
    log,
  });

  accountStates.set(accountId, {
    commandTokens: tokenSet,
    registeredCommands,
    handler,
    account,
    triggerMap: triggerMap ?? new Map(),
  });

  log?.(
    `mattermost: slash commands activated for account ${accountId} (${registeredCommands.length} commands)`,
  );
}

/**
 * Deactivate slash commands for a specific account (on shutdown/disconnect).
 */
export function deactivateSlashCommands(accountId?: string) {
  if (accountId) {
    const state = accountStates.get(accountId);
    if (state) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
      clearMattermostSlashCommandValidationCacheForAccount(accountId);
      accountStates.delete(accountId);
    }
  } else {
    // Deactivate all accounts (full shutdown)
    for (const [stateAccountId, state] of accountStates) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
      clearMattermostSlashCommandValidationCacheForAccount(stateAccountId);
    }
    accountStates.clear();
  }
}

/**
 * Register the HTTP route for slash command callbacks.
 * Called during plugin registration.
 *
 * The single HTTP route dispatches to the correct per-account handler by
 * matching the inbound token against each account's known tokens, falling back
 * to registered team/trigger ownership so upstream validation can accept a
 * rotated Mattermost token.
 */
export function registerSlashCommandRoute(api: OpenClawPluginApi) {
  const mmConfig = api.config.channels?.mattermost as MattermostConfig | undefined;

  // Collect callback paths from both top-level and per-account config.
  // Command registration uses account.config.commands, so the HTTP route
  // registration must include any account-specific callbackPath overrides.
  // Also extract the pathname from an explicit callbackUrl when it differs
  // from callbackPath, so that Mattermost callbacks hit a registered route.
  const callbackPaths = new Set<string>();

  const addCallbackPaths = (
    raw: Partial<import("./slash-commands.js").MattermostSlashCommandConfig> | undefined,
  ) => {
    const resolved = resolveSlashCommandConfig(raw);
    callbackPaths.add(resolved.callbackPath);
    if (resolved.callbackUrl) {
      try {
        const urlPath = new URL(resolved.callbackUrl).pathname;
        if (urlPath && urlPath !== resolved.callbackPath) {
          callbackPaths.add(urlPath);
        }
      } catch {
        // Invalid URL — ignore, will be caught during registration
      }
    }
  };

  const commandsRaw = mmConfig?.commands as
    | Partial<import("./slash-commands.js").MattermostSlashCommandConfig>
    | undefined;
  addCallbackPaths(commandsRaw);

  const accountsRaw = mmConfig?.accounts ?? {};
  for (const accountId of Object.keys(accountsRaw)) {
    const accountCommandsRaw = accountsRaw[accountId]?.commands;
    addCallbackPaths(accountCommandsRaw);
  }

  const routeHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (accountStates.size === 0) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: "Slash commands are not yet initialized. Please try again in a moment.",
        }),
      );
      return;
    }

    // We need to peek at the body to route to the right account handler. Each
    // account handler still performs upstream token validation before running a
    // command.

    // If there's only one active account (common case), route directly.
    if (accountStates.size === 1) {
      const [, state] = [...accountStates.entries()][0];
      if (!state.handler) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            response_type: "ephemeral",
            text: "Slash commands are not yet initialized. Please try again in a moment.",
          }),
        );
        return;
      }
      await state.handler(req, res);
      return;
    }

    // Multi-account: buffer the body, find the matching account by token or
    // registered team/trigger, then replay the request to the correct handler.
    // Use the bounded helper so a slow/never-finishing client cannot tie up the
    // routing handler indefinitely (Slowloris).
    let bodyStr: string;
    try {
      bodyStr = await readRequestBodyWithLimit(req, {
        maxBytes: MULTI_ACCOUNT_BODY_MAX_BYTES,
        timeoutMs: MULTI_ACCOUNT_BODY_TIMEOUT_MS,
      });
    } catch (error) {
      if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.end("Request body timeout");
        return;
      }
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }

    // Parse the token for the fast path; if it misses, parse the full slash
    // payload so rotated tokens can still route by registered team/trigger.
    let token: string | null = null;
    const ct = req.headers["content-type"] ?? "";
    try {
      if (ct.includes("application/json")) {
        token = (JSON.parse(bodyStr) as { token?: string }).token ?? null;
      } else {
        token = new URLSearchParams(bodyStr).get("token");
      }
    } catch {
      // parse failed — will be caught by handler
    }

    let match: SlashHandlerMatch = token ? resolveSlashHandlerForToken(token) : { kind: "none" };
    if (match.kind === "none") {
      const payload = parseSlashCommandPayload(bodyStr, ct);
      if (payload) {
        match = resolveSlashHandlerForCommand({
          teamId: payload.team_id,
          command: payload.command,
        });
      }
    }

    if (match.kind === "none") {
      // No matching account — reject
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: "Unauthorized: invalid command token.",
        }),
      );
      return;
    }

    if (match.kind === "ambiguous") {
      api.logger.warn?.(
        `mattermost: slash callback matched multiple accounts via ${match.source} (${match.accountIds.join(", ")})`,
      );
      const conflictText =
        match.source === "token"
          ? "Conflict: command token is not unique across accounts."
          : "Conflict: slash command is not unique across accounts.";
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: conflictText,
        }),
      );
      return;
    }

    const matchedHandler = match.handler;

    // Replay: create a synthetic readable that re-emits the buffered body
    const syntheticReq = new Readable({
      read() {
        this.push(Buffer.from(bodyStr, "utf8"));
        this.push(null);
      },
    }) as IncomingMessage;

    // Copy necessary IncomingMessage properties
    syntheticReq.method = req.method;
    syntheticReq.url = req.url;
    syntheticReq.headers = req.headers;

    await matchedHandler(syntheticReq, res);
  };

  for (const callbackPath of callbackPaths) {
    api.registerHttpRoute({
      path: callbackPath,
      auth: "plugin",
      handler: routeHandler,
    });
  }
}
