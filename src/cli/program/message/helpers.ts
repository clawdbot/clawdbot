// Shared helpers for message CLI actions: common flags, plugin preload, numeric validation, and stop hooks.
import type { Command } from "commander";
import { getChannelPlugin } from "../../../channels/plugins/index.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../../channels/plugins/types.public.js";
import { resolveMessageSecretScope } from "../../../cli/message-secret-scope.js";
import { messageCommand } from "../../../commands/message.js";
import { danger, setVerbose } from "../../../globals.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "../../../infra/parse-finite-number.js";
import { runGlobalGatewayStopSafely } from "../../../plugins/hook-runner-global.js";
import { defaultRuntime } from "../../../runtime.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { createDefaultDeps } from "../../deps.js";
import { ensurePluginRegistryLoaded, type PluginRegistryScope } from "../../plugin-registry.js";

/** Shared helpers used by every message subcommand registration. */
export type MessageCliHelpers = {
  withMessageBase: (command: Command) => Command;
  withMessageTarget: (command: Command) => Command;
  withRequiredMessageTarget: (command: Command) => Command;
  runMessageAction: (action: string, opts: Record<string, unknown>) => Promise<void>;
};

const GATEWAY_STOP_TIMEOUT_MS = 2500;
const ACTIONS_WITHOUT_STOP_HOOKS = new Set(["read"]);
const ACTIONS_REQUIRING_CONFIGURED_CHANNEL_PRELOAD = new Set(["broadcast"]);
const CHANNEL_MESSAGE_ACTION_NAME_SET = new Set<string>(CHANNEL_MESSAGE_ACTION_NAMES);
const STRICT_POSITIVE_INTEGER_OPTIONS = new Map([
  ["pollDurationHours", "--poll-duration-hours"],
  ["pollDurationSeconds", "--poll-duration-seconds"],
  ["limit", "--limit"],
  ["autoArchiveMin", "--auto-archive-min"],
]);
const STRICT_NON_NEGATIVE_INTEGER_OPTIONS = new Map([
  ["durationMin", "--duration-min"],
  ["deleteDays", "--delete-days"],
]);

type MessagePluginLoadOptions = { scope: PluginRegistryScope; onlyChannelIds?: string[] };
type MessagePluginPreloadPlan =
  | { preload: true; loadOptions: MessagePluginLoadOptions }
  | { preload: false };

function normalizeMessageOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const { account, ...rest } = opts;
  return {
    ...rest,
    accountId: typeof account === "string" ? account : rest.accountId,
  };
}

function validateMessageNumericOptions(opts: Record<string, unknown>): void {
  for (const [key, flag] of STRICT_POSITIVE_INTEGER_OPTIONS) {
    if (opts[key] === undefined) {
      continue;
    }
    if (parseStrictPositiveInteger(opts[key]) === undefined) {
      throw new Error(`${flag} must be a positive integer.`);
    }
  }
  for (const [key, flag] of STRICT_NON_NEGATIVE_INTEGER_OPTIONS) {
    if (opts[key] === undefined) {
      continue;
    }
    if (parseStrictNonNegativeInteger(opts[key]) === undefined) {
      throw new Error(`${flag} must be a non-negative integer.`);
    }
  }
}

async function runPluginStopHooks(): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  const hookRun = runGlobalGatewayStopSafely({
    event: { reason: "cli message action complete" },
    ctx: {},
    onError: (err) => defaultRuntime.error(danger(`gateway_stop hook failed: ${String(err)}`)),
  });
  const bounded = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), GATEWAY_STOP_TIMEOUT_MS);
    timeout.unref?.();
  });
  const result = await Promise.race([hookRun.then(() => "done" as const), bounded]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (result === "timeout") {
    defaultRuntime.error(
      danger(`gateway_stop hook exceeded ${GATEWAY_STOP_TIMEOUT_MS}ms; continuing`),
    );
  }
}

function resolveScopedMessageChannel(opts: Record<string, unknown>): string | undefined {
  return resolveMessageSecretScope({
    channel: opts.channel,
    target: opts.target,
    targets: opts.targets,
  }).channel;
}

function asChannelMessageActionName(action: string): ChannelMessageActionName | undefined {
  return CHANNEL_MESSAGE_ACTION_NAME_SET.has(action)
    ? (action as ChannelMessageActionName)
    : undefined;
}

function isGatewayOwnedMessageAction(action: string, scopedChannel: string | undefined): boolean {
  const messageAction = asChannelMessageActionName(action);
  if (!messageAction || !scopedChannel) {
    return false;
  }
  const plugin = getChannelPlugin(scopedChannel);
  const executionMode = plugin?.actions?.resolveExecutionMode?.({
    action: messageAction,
  });
  return executionMode === "gateway";
}

function resolveMessagePluginPreloadPlan(
  action: string,
  opts: Record<string, unknown>,
): MessagePluginPreloadPlan {
  const scopedChannel = resolveScopedMessageChannel(opts);
  const loadOptions = scopedChannel
    ? { scope: "configured-channels" as const, onlyChannelIds: [scopedChannel] }
    : { scope: "configured-channels" as const };
  // Gateway-owned actions can execute without loading channel plugins in the CLI process;
  // dry-runs, broadcasts, and local actions need registry metadata before building payloads.
  if (
    opts.dryRun === true ||
    ACTIONS_REQUIRING_CONFIGURED_CHANNEL_PRELOAD.has(action) ||
    !isGatewayOwnedMessageAction(action, scopedChannel)
  ) {
    return { preload: true, loadOptions };
  }
  return { preload: false };
}

/** Create shared option decorators and the common message action runner. */
export function createMessageCliHelpers(
  message: Command,
  messageChannelOptions: string,
): MessageCliHelpers {
  const withMessageBase = (command: Command) =>
    command
      .option("--channel <channel>", `Channel: ${messageChannelOptions}`)
      .option("--account <id>", "Channel account id (accountId)")
      .option("--json", "Output result as JSON", false)
      .option("--dry-run", "Print payload and skip sending", false)
      .option("--verbose", "Verbose logging", false);

  const withMessageTarget = (command: Command) =>
    command.option("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);
  const withRequiredMessageTarget = (command: Command) =>
    command.requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION);

  const runMessageAction = async (action: string, opts: Record<string, unknown>) => {
    setVerbose(Boolean(opts.verbose));
    let failed = false;
    await runCommandWithRuntime(
      defaultRuntime,
      async () => {
        validateMessageNumericOptions(opts);
        const preloadPlan = resolveMessagePluginPreloadPlan(action, opts);
        if (preloadPlan.preload) {
          ensurePluginRegistryLoaded(preloadPlan.loadOptions);
        }
        const deps = createDefaultDeps();
        await messageCommand(
          {
            ...normalizeMessageOptions(opts),
            action,
          },
          deps,
          defaultRuntime,
        );
      },
      (err) => {
        failed = true;
        defaultRuntime.error(danger(String(err)));
      },
    );
    // Outbound actions may start plugin-side resources; run bounded stop hooks even after failure.
    if (!ACTIONS_WITHOUT_STOP_HOOKS.has(action)) {
      await runPluginStopHooks();
    }
    defaultRuntime.exit(failed ? 1 : 0);
  };

  // `message` is only used for `message.help({ error: true })`, keep the
  // command-specific helpers grouped here.
  void message;

  return {
    withMessageBase,
    withMessageTarget,
    withRequiredMessageTarget,
    runMessageAction,
  };
}
