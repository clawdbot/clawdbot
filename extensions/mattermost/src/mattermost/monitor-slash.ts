import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  type MattermostClient,
} from "./client.js";
import {
  listSkillCommandsForAgents,
  parseStrictPositiveInteger,
  type OpenClawConfig,
  type RuntimeEnv,
} from "./runtime-api.js";
import {
  DEFAULT_COMMAND_SPECS,
  isSlashCommandsEnabled,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandConfig,
  type MattermostCommandSpec,
  type MattermostRegisteredCommand,
  type MattermostSlashCommandConfig,
} from "./slash-commands.js";
import { activateSlashCommands } from "./slash-state.js";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function buildSlashCommands(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  nativeSkills: boolean;
}): MattermostCommandSpec[] {
  const commandsToRegister: MattermostCommandSpec[] = [...DEFAULT_COMMAND_SPECS];
  if (!params.nativeSkills) {
    return commandsToRegister;
  }
  try {
    const skillCommands = listSkillCommandsForAgents({ cfg: params.cfg });
    for (const spec of skillCommands) {
      const name = typeof spec.name === "string" ? spec.name.trim() : "";
      if (!name) {
        continue;
      }
      const trigger = name.startsWith("oc_") ? name : `oc_${name}`;
      commandsToRegister.push({
        trigger,
        description: spec.description || `Run skill ${name}`,
        autoComplete: true,
        autoCompleteHint: "[args]",
        originalName: name,
      });
    }
  } catch (err) {
    params.runtime.error?.(`mattermost: failed to list skill commands: ${String(err)}`);
  }
  return commandsToRegister;
}

function dedupeSlashCommands(commands: MattermostCommandSpec[]): MattermostCommandSpec[] {
  const seen = new Set<string>();
  return commands.filter((cmd) => {
    const key = cmd.trigger.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildTriggerMap(commands: MattermostCommandSpec[]): Map<string, string> {
  const triggerMap = new Map<string, string>();
  for (const cmd of commands) {
    if (cmd.originalName) {
      triggerMap.set(cmd.trigger, cmd.originalName);
    }
  }
  return triggerMap;
}

function warnOnSuspiciousCallbackUrl(params: {
  runtime: RuntimeEnv;
  baseUrl: string;
  callbackUrl: string;
}) {
  try {
    const mmHost = new URL(normalizeMattermostBaseUrl(params.baseUrl) ?? params.baseUrl).hostname;
    const callbackHost = new URL(params.callbackUrl).hostname;

    if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
      params.runtime.error?.(
        `mattermost: slash commands callbackUrl resolved to ${params.callbackUrl} (loopback) while baseUrl is ${params.baseUrl}. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`,
      );
    }
  } catch {
    // Ignore malformed URLs and let the downstream registration fail naturally.
  }
}

async function registerSlashCommandsAcrossTeams(params: {
  client: MattermostClient;
  teams: Array<{ id: string }>;
  botUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  runtime: RuntimeEnv;
}): Promise<{
  registered: MattermostRegisteredCommand[];
  teamRegistrationFailures: number;
}> {
  const registered: MattermostRegisteredCommand[] = [];
  let teamRegistrationFailures = 0;

  for (const team of params.teams) {
    try {
      const created = await registerSlashCommands({
        client: params.client,
        teamId: team.id,
        creatorUserId: params.botUserId,
        callbackUrl: params.callbackUrl,
        commands: params.commands,
        log: (msg) => params.runtime.log?.(msg),
      });
      registered.push(...created);
    } catch (err) {
      teamRegistrationFailures += 1;
      params.runtime.error?.(
        `mattermost: failed to register slash commands for team ${team.id}: ${String(err)}`,
      );
    }
  }

  return { registered, teamRegistrationFailures };
}

export async function registerMattermostMonitorSlashCommands(params: {
  client: MattermostClient;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedMattermostAccount;
  baseUrl: string;
  botUserId: string;
}) {
  const commandsRaw = params.account.config.commands as
    | Partial<MattermostSlashCommandConfig>
    | undefined;
  const slashConfig = resolveSlashCommandConfig(commandsRaw);
  if (!isSlashCommandsEnabled(slashConfig)) {
    return;
  }

  try {
    const teams = await fetchMattermostUserTeams(params.client, params.botUserId);
    const envPort = parseStrictPositiveInteger(process.env.OPENCLAW_GATEWAY_PORT?.trim());
    const slashGatewayPort = envPort ?? params.cfg.gateway?.port ?? 18789;
    const slashCallbackUrl = resolveCallbackUrl({
      config: slashConfig,
      gatewayPort: slashGatewayPort,
      gatewayHost: params.cfg.gateway?.customBindHost ?? undefined,
    });

    warnOnSuspiciousCallbackUrl({
      runtime: params.runtime,
      baseUrl: params.baseUrl,
      callbackUrl: slashCallbackUrl,
    });

    const dedupedCommands = dedupeSlashCommands(
      buildSlashCommands({
        cfg: params.cfg,
        runtime: params.runtime,
        nativeSkills: slashConfig.nativeSkills === true,
      }),
    );
    const { registered, teamRegistrationFailures } = await registerSlashCommandsAcrossTeams({
      client: params.client,
      teams,
      botUserId: params.botUserId,
      callbackUrl: slashCallbackUrl,
      commands: dedupedCommands,
      runtime: params.runtime,
    });

    if (registered.length === 0) {
      params.runtime.error?.(
        "mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive",
      );
      return;
    }

    if (teamRegistrationFailures > 0) {
      params.runtime.error?.(
        `mattermost: slash command registration completed with ${teamRegistrationFailures} team error(s)`,
      );
    }

    activateSlashCommands({
      account: params.account,
      commandTokens: registered.map((cmd) => cmd.token).filter(Boolean),
      registeredCommands: registered,
      triggerMap: buildTriggerMap(dedupedCommands),
      api: { cfg: params.cfg, runtime: params.runtime },
      log: (msg) => params.runtime.log?.(msg),
    });

    params.runtime.log?.(
      `mattermost: slash commands registered (${registered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`,
    );
  } catch (err) {
    params.runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
  }
}
