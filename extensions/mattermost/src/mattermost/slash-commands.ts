import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostClient } from "./client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export const MATTERMOST_SLASH_POST_METHOD = "P";

export type MattermostSlashCommandConfig = {
  /** Enable native slash commands. "auto" resolves to false for now (opt-in). */
  native: boolean | "auto";
  /** Also register skill-based commands. */
  nativeSkills: boolean | "auto";
  /** Path for the callback endpoint on the gateway HTTP server. */
  callbackPath: string;
  /**
   * Explicit callback URL override (e.g. behind a reverse proxy).
   * If not set, auto-derived from baseUrl + gateway port + callbackPath.
   */
  callbackUrl?: string;
};

export type MattermostCommandSpec = {
  trigger: string;
  description: string;
  autoComplete: boolean;
  autoCompleteHint?: string;
  /** Original command name (for skill commands that start with oc_) */
  originalName?: string;
};

export type MattermostRegisteredCommand = {
  id: string;
  trigger: string;
  teamId: string;
  token: string;
  url: string;
  /** True when this process created the command and should delete it on shutdown. */
  managed: boolean;
};

/**
 * Payload sent by Mattermost when a slash command is invoked.
 * Can arrive as application/x-www-form-urlencoded or application/json.
 */
export type MattermostSlashCommandPayload = {
  token: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  command: string; // e.g. "/status"
  text: string; // args after the trigger word
  trigger_id?: string;
  response_url?: string;
};

/**
 * Response format for Mattermost slash command callbacks.
 */
export type MattermostSlashCommandResponse = {
  response_type?: "ephemeral" | "in_channel";
  text: string;
  username?: string;
  icon_url?: string;
  goto_location?: string;
  attachments?: unknown[];
};

// ─── MM API types ────────────────────────────────────────────────────────────

type MattermostCommandCreate = {
  team_id: string;
  trigger: string;
  method: typeof MATTERMOST_SLASH_POST_METHOD | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  token?: string;
  creator_id?: string;
};

type MattermostCommandUpdate = {
  id: string;
  team_id: string;
  trigger: string;
  method: typeof MATTERMOST_SLASH_POST_METHOD | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
};

export type MattermostCommandResponse = {
  id: string;
  token: string;
  team_id: string;
  trigger: string;
  method: string;
  url: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  creator_id?: string;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
};

// ─── Default commands ────────────────────────────────────────────────────────

/**
 * Built-in OpenClaw commands to register as native slash commands.
 * These mirror the text-based commands already handled by the gateway.
 */
export const DEFAULT_COMMAND_SPECS: MattermostCommandSpec[] = [
  {
    trigger: "oc_status",
    originalName: "status",
    description: "Show session status (model, usage, uptime)",
    autoComplete: true,
  },
  {
    trigger: "oc_model",
    originalName: "model",
    description: "View or change the current model",
    autoComplete: true,
    autoCompleteHint: "[model-name] [--runtime runtime]",
  },
  {
    trigger: "oc_models",
    originalName: "models",
    description: "Browse available models",
    autoComplete: true,
    autoCompleteHint: "[provider]",
  },
  {
    trigger: "oc_new",
    originalName: "new",
    description: "Start a new conversation session",
    autoComplete: true,
  },
  {
    trigger: "oc_help",
    originalName: "help",
    description: "Show available commands",
    autoComplete: true,
  },
  {
    trigger: "oc_think",
    originalName: "think",
    description: "Set thinking/reasoning level",
    autoComplete: true,
    autoCompleteHint: "[off|low|medium|high]",
  },
  {
    trigger: "oc_reasoning",
    originalName: "reasoning",
    description: "Toggle reasoning mode",
    autoComplete: true,
    autoCompleteHint: "[on|off]",
  },
  {
    trigger: "oc_verbose",
    originalName: "verbose",
    description: "Toggle verbose mode",
    autoComplete: true,
    autoCompleteHint: "[on|off]",
  },
];

// ─── Command registration ────────────────────────────────────────────────────

/**
 * List existing custom slash commands for a team.
 */
export async function listMattermostCommands(
  client: MattermostClient,
  teamId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<MattermostCommandResponse[]> {
  return await client.request<MattermostCommandResponse[]>(
    `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`,
    init,
  );
}

/**
 * Get a custom slash command by id.
 */
export async function getMattermostCommand(
  client: MattermostClient,
  commandId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>(
    `/commands/${encodeURIComponent(commandId)}`,
    init,
  );
}

/**
 * Create a custom slash command on a Mattermost team.
 */
async function createMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandCreate,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>("/commands", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Delete a custom slash command.
 */
async function deleteMattermostCommand(client: MattermostClient, commandId: string): Promise<void> {
  await client.request<Record<string, unknown>>(`/commands/${encodeURIComponent(commandId)}`, {
    method: "DELETE",
  });
}

/**
 * Update an existing custom slash command.
 */
async function updateMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandUpdate,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>(
    `/commands/${encodeURIComponent(params.id)}`,
    {
      method: "PUT",
      body: JSON.stringify(params),
    },
  );
}

/**
 * Register all OpenClaw slash commands for a given team.
 * Skips commands that are already registered with the same trigger + callback URL.
 * Returns the list of newly created command IDs.
 */
export async function registerSlashCommands(params: {
  client: MattermostClient;
  teamId: string;
  creatorUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  log?: (msg: string) => void;
}): Promise<MattermostRegisteredCommand[]> {
  const { client, teamId, creatorUserId, callbackUrl, commands, log } = params;
  const normalizedCreatorUserId = creatorUserId.trim();
  if (!normalizedCreatorUserId) {
    throw new Error("creatorUserId is required for slash command reconciliation");
  }

  // Fetch existing commands to avoid duplicates
  let existing: MattermostCommandResponse[] = [];
  try {
    existing = await listMattermostCommands(client, teamId);
  } catch (err) {
    log?.(`mattermost: failed to list existing commands: ${String(err)}`);
    // Fail closed: if we can't list existing commands, we should not attempt to
    // create/update anything because we may create duplicates and end up with an
    // empty/partial token set (causing callbacks to be rejected until restart).
    throw err;
  }

  const existingByTrigger = new Map<string, MattermostCommandResponse[]>();
  for (const cmd of existing) {
    const list = existingByTrigger.get(cmd.trigger) ?? [];
    list.push(cmd);
    existingByTrigger.set(cmd.trigger, list);
  }

  const registered: MattermostRegisteredCommand[] = [];

  for (const spec of commands) {
    const existingForTrigger = existingByTrigger.get(spec.trigger) ?? [];
    const ownedCommands = existingForTrigger.filter(
      (cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId,
    );
    const foreignCommands = existingForTrigger.filter(
      (cmd) => cmd.creator_id?.trim() !== normalizedCreatorUserId,
    );

    if (ownedCommands.length === 0 && foreignCommands.length > 0) {
      log?.(
        `mattermost: trigger /${spec.trigger} already used by non-OpenClaw command(s); skipping to avoid mutating external integrations`,
      );
      continue;
    }

    if (ownedCommands.length > 1) {
      log?.(
        `mattermost: multiple owned commands found for /${spec.trigger}; using the first and leaving extras untouched`,
      );
    }

    const existingCmd = ownedCommands[0];

    const existingNeedsUpdate = existingCmd
      ? existingCmd.url !== callbackUrl || existingCmd.method !== MATTERMOST_SLASH_POST_METHOD
      : false;

    // Already registered with the correct callback URL and method.
    if (existingCmd && !existingNeedsUpdate) {
      log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
      registered.push({
        id: existingCmd.id,
        trigger: spec.trigger,
        teamId,
        token: existingCmd.token,
        url: callbackUrl,
        managed: false,
      });
      continue;
    }

    // Exists but has drifted critical callback fields: attempt to reconcile by
    // updating (useful during callback URL migrations or method drift).
    if (existingCmd && existingNeedsUpdate) {
      log?.(
        `mattermost: command /${spec.trigger} exists with different callback settings; updating (id=${existingCmd.id})`,
      );
      try {
        const updated = await updateMattermostCommand(client, {
          id: existingCmd.id,
          team_id: teamId,
          trigger: spec.trigger,
          method: MATTERMOST_SLASH_POST_METHOD,
          url: callbackUrl,
          description: spec.description,
          auto_complete: spec.autoComplete,
          auto_complete_desc: spec.description,
          auto_complete_hint: spec.autoCompleteHint,
        });
        registered.push({
          id: updated.id,
          trigger: spec.trigger,
          teamId,
          token: updated.token,
          url: callbackUrl,
          managed: false,
        });
        continue;
      } catch (err) {
        log?.(
          `mattermost: failed to update command /${spec.trigger} (id=${existingCmd.id}): ${String(err)}`,
        );
        // Fallback: try delete+recreate for commands owned by this bot user.
        try {
          await deleteMattermostCommand(client, existingCmd.id);
          log?.(`mattermost: deleted stale command /${spec.trigger} (id=${existingCmd.id})`);
        } catch (deleteErr) {
          log?.(
            `mattermost: failed to delete stale command /${spec.trigger} (id=${existingCmd.id}): ${String(deleteErr)}`,
          );
          // Can't reconcile; skip this command.
          continue;
        }
        // Continue on to create below.
      }
    }

    try {
      const created = await createMattermostCommand(client, {
        team_id: teamId,
        trigger: spec.trigger,
        method: MATTERMOST_SLASH_POST_METHOD,
        url: callbackUrl,
        description: spec.description,
        auto_complete: spec.autoComplete,
        auto_complete_desc: spec.description,
        auto_complete_hint: spec.autoCompleteHint,
      });
      log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
      registered.push({
        id: created.id,
        trigger: spec.trigger,
        teamId,
        token: created.token,
        url: callbackUrl,
        managed: true,
      });
    } catch (err) {
      log?.(`mattermost: failed to register command /${spec.trigger}: ${String(err)}`);
    }
  }

  return registered;
}

/**
 * Clean up all registered slash commands.
 */
export async function cleanupSlashCommands(params: {
  client: MattermostClient;
  commands: MattermostRegisteredCommand[];
  log?: (msg: string) => void;
}): Promise<void> {
  const { client, commands, log } = params;
  for (const cmd of commands) {
    if (!cmd.managed) {
      continue;
    }
    try {
      await deleteMattermostCommand(client, cmd.id);
      log?.(`mattermost: deleted command /${cmd.trigger} (id=${cmd.id})`);
    } catch (err) {
      log?.(`mattermost: failed to delete command /${cmd.trigger}: ${String(err)}`);
    }
  }
}

// ─── Callback parsing ────────────────────────────────────────────────────────

/**
 * Parse a Mattermost slash command callback payload from a URL-encoded or JSON body.
 */
export function parseSlashCommandPayload(
  body: string,
  contentType?: string,
): MattermostSlashCommandPayload | null {
  if (!body) {
    return null;
  }

  try {
    if (contentType?.includes("application/json")) {
      const parsed = JSON.parse(body) as Record<string, unknown>;

      // Validate required fields (same checks as the form-encoded branch)
      const token = typeof parsed.token === "string" ? parsed.token : "";
      const teamId = typeof parsed.team_id === "string" ? parsed.team_id : "";
      const channelId = typeof parsed.channel_id === "string" ? parsed.channel_id : "";
      const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
      const command = typeof parsed.command === "string" ? parsed.command : "";

      if (!token || !teamId || !channelId || !userId || !command) {
        return null;
      }

      return {
        token,
        team_id: teamId,
        team_domain: typeof parsed.team_domain === "string" ? parsed.team_domain : undefined,
        channel_id: channelId,
        channel_name: typeof parsed.channel_name === "string" ? parsed.channel_name : undefined,
        user_id: userId,
        user_name: typeof parsed.user_name === "string" ? parsed.user_name : undefined,
        command,
        text: typeof parsed.text === "string" ? parsed.text : "",
        trigger_id: typeof parsed.trigger_id === "string" ? parsed.trigger_id : undefined,
        response_url: typeof parsed.response_url === "string" ? parsed.response_url : undefined,
      };
    }

    // Default: application/x-www-form-urlencoded
    const params = new URLSearchParams(body);
    const token = params.get("token");
    const teamId = params.get("team_id");
    const channelId = params.get("channel_id");
    const userId = params.get("user_id");
    const command = params.get("command");

    if (!token || !teamId || !channelId || !userId || !command) {
      return null;
    }

    return {
      token,
      team_id: teamId,
      team_domain: params.get("team_domain") ?? undefined,
      channel_id: channelId,
      channel_name: params.get("channel_name") ?? undefined,
      user_id: userId,
      user_name: params.get("user_name") ?? undefined,
      command,
      text: params.get("text") ?? "",
      trigger_id: params.get("trigger_id") ?? undefined,
      response_url: params.get("response_url") ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Map the trigger word back to the original OpenClaw command name.
 * e.g. "oc_status" -> "/status", "oc_model" -> "/model"
 */
export function resolveCommandText(
  trigger: string,
  text: string,
  triggerMap?: ReadonlyMap<string, string>,
): string {
  // Use the trigger map if available for accurate name resolution
  const commandName =
    triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
  const args = text.trim();
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}

export function normalizeSlashCommandTrigger(command: string): string {
  return command.replace(/^\//, "").trim();
}

// ─── Config resolution ───────────────────────────────────────────────────────

const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";

/**
 * Ensure the callback path starts with a leading `/` to prevent
 * malformed URLs like `http://host:portapi/...`.
 */
function normalizeCallbackPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return DEFAULT_CALLBACK_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveSlashCommandConfig(
  raw?: Partial<MattermostSlashCommandConfig>,
): MattermostSlashCommandConfig {
  return {
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
    callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
    callbackUrl: normalizeOptionalString(raw?.callbackUrl),
  };
}

export function isSlashCommandsEnabled(config: MattermostSlashCommandConfig): boolean {
  if (config.native === true) {
    return true;
  }
  if (config.native === false) {
    return false;
  }
  // "auto" defaults to false for mattermost (opt-in)
  return false;
}

/**
 * Build the callback URL that Mattermost will POST to when a command is invoked.
 */
export function resolveCallbackUrl(params: {
  config: MattermostSlashCommandConfig;
  gatewayPort: number;
  gatewayHost?: string;
}): string {
  if (params.config.callbackUrl) {
    return params.config.callbackUrl;
  }

  const isWildcardBindHost = (rawHost: string): boolean => {
    const trimmed = rawHost.trim();
    if (!trimmed) {
      return false;
    }
    const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

    // NOTE: Wildcard listen hosts are valid bind addresses but are not routable callback
    // destinations. Don't emit callback URLs like http://0.0.0.0:3015/... or http://[::]:3015/...
    // when an operator sets gateway.customBindHost.
    return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
  };

  let host =
    params.gatewayHost && !isWildcardBindHost(params.gatewayHost)
      ? params.gatewayHost
      : "localhost";
  const path = normalizeCallbackPath(params.config.callbackPath);

  // Bracket IPv6 literals so the URL is valid: http://[::1]:3015/...
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }

  return `http://${host}:${params.gatewayPort}${path}`;
}
