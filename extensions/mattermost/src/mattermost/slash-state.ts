/**
 * Shared state for Mattermost slash commands.
 *
 * Bridges the plugin registration phase (HTTP route) with the monitor phase
 * (command registration with MM API). The HTTP handler needs to know which
 * tokens are valid, and the monitor needs to store registered command IDs.
 *
 * State is kept per-account so that multi-account deployments don't
 * overwrite each other's tokens, registered commands, or handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { MattermostConfig } from "../types.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { resolveSlashCommandConfig, type MattermostRegisteredCommand } from "./slash-commands.js";
import { createSlashCommandHttpHandler } from "./slash-http.js";

// ─── Per-account state ───────────────────────────────────────────────────────

export type SlashCommandAccountState = {
  /** Tokens from registered commands, used for validation. */
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

export function resolveSlashHandlerForToken(token: string): {
  kind: "none" | "single" | "ambiguous";
  handler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  accountIds?: string[];
} {
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
    return { kind: "single", handler: matches[0].handler, accountIds: [matches[0].accountId] };
  }

  return {
    kind: "ambiguous",
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
 * Get all active slash command account states.
 */
export function getAllSlashCommandStates(): ReadonlyMap<string, SlashCommandAccountState> {
  return accountStates;
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
    commandTokens: tokenSet,
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
      accountStates.delete(accountId);
    }
  } else {
    // Deactivate all accounts (full shutdown)
    for (const [, state] of accountStates) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
    }
    accountStates.clear();
  }
}

/**
 * Register the HTTP route for slash command callbacks.
 * Called during plugin registration.
 *
 * The single HTTP route dispatches to the correct per-account handler
 * by matching the inbound token against each account's registered tokens.
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

    // We need to peek at the token to route to the right account handler.
    // Since each account handler also validates the token, we find the
    // account whose token set contains the inbound token and delegate.

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

    // Multi-account: buffer the body, find the matching account by token,
    // then replay the request to the correct handler.
    const chunks: Buffer[] = [];
    const MAX_BODY = 64 * 1024;
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf8");

    // Parse just the token to find the right account
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

    const match = token ? resolveSlashHandlerForToken(token) : { kind: "none" as const };

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
        `mattermost: slash callback token matched multiple accounts (${match.accountIds?.join(", ")})`,
      );
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: "Conflict: command token is not unique across accounts.",
        }),
      );
      return;
    }

    const matchedHandler = match.handler!;

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
