import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { getChannelPlugin } from "../../../channels/plugins/index.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../../channels/plugins/types.public.js";
import { resolveMessageSecretScope } from "../../../cli/message-secret-scope.js";
import { messageCommand } from "../../../commands/message.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { danger, setVerbose } from "../../../globals.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { CHANNEL_TARGET_DESCRIPTION } from "../../../infra/outbound/channel-target.js";
import { resolveMessageActionOutcome } from "../../../infra/outbound/message-action-contracts.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { withActivatedPluginIds } from "../../../plugins/activation-context.js";
import {
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../../plugins/channel-plugin-ids.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { loadPluginRegistryHandle } from "../../../plugins/loader.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  ABSOLUTE_DEADLINE_EXPIRED,
  awaitWithinDeadline,
} from "../../../utils/absolute-deadline.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { createDefaultDeps } from "../../deps.js";
import { requestExitAfterOneShotOutput } from "../../one-shot-exit.js";

/** Shared helpers used by every message subcommand registration. */
export type MessageCliHelpers = {
  withMessageBase: (command: Command) => Command;
  withMessageTarget: (command: Command) => Command;
  withRequiredMessageTarget: (command: Command) => Command;
  runMessageAction: (action: string, opts: Record<string, unknown>) => Promise<void>;
};

const GATEWAY_STOP_TIMEOUT_MS = 2500;
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

type MessagePluginPreloadPlan = { preload: true; channelId?: string } | { preload: false };

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

async function runPluginStopHooks(registry: PluginRegistry): Promise<void> {
  const runner = createHookRunner(registry, { logger: createSubsystemLogger("plugins") });
  const result = await awaitWithinDeadline(
    () =>
      withPluginRuntimeRegistryScope(registry, () =>
        runner.runGatewayStop({ reason: "cli message action complete" }, {}),
      ),
    Date.now() + GATEWAY_STOP_TIMEOUT_MS,
  );
  if (result === ABSOLUTE_DEADLINE_EXPIRED) {
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
  // Gateway-owned actions can execute without loading channel plugins in the CLI process;
  // dry-runs, broadcasts, and local actions need registry metadata before building payloads.
  if (
    opts.dryRun === true ||
    ACTIONS_REQUIRING_CONFIGURED_CHANNEL_PRELOAD.has(action) ||
    !isGatewayOwnedMessageAction(action, scopedChannel)
  ) {
    return { preload: true, ...(scopedChannel ? { channelId: scopedChannel } : {}) };
  }
  return { preload: false };
}

/** Create shared option decorators and the common message action runner. */
export function createMessageCliHelpers(messageChannelOptions: string): MessageCliHelpers {
  return {
    withMessageBase: (command) =>
      command
        .option("--channel <channel>", `Channel: ${messageChannelOptions}`)
        .option("--account <id>", "Channel account id (accountId)")
        .option("--json", "Output result as JSON", false)
        .option("--dry-run", "Print payload and skip sending", false)
        .option("--verbose", "Verbose logging", false),

    withMessageTarget: (command) =>
      command.option("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION),
    withRequiredMessageTarget: (command) =>
      command.requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION),

    runMessageAction: async (action, opts) => {
      setVerbose(Boolean(opts.verbose));
      let failed = false;
      let result: Awaited<ReturnType<typeof messageCommand>> | undefined;
      let pluginRegistry: PluginRegistry | undefined;
      try {
        await runCommandWithRuntime(
          defaultRuntime,
          async () => {
            validateMessageNumericOptions(opts);
            if (action === "poll" && opts.pollAnonymous === true && opts.pollPublic === true) {
              throw new Error("--poll-anonymous and --poll-public are mutually exclusive.");
            }
            const preloadPlan = resolveMessagePluginPreloadPlan(action, opts);
            if (preloadPlan.preload) {
              const config = getRuntimeConfig();
              const pluginIds = preloadPlan.channelId
                ? resolveDiscoverableScopedChannelPluginIds({
                    config,
                    activationSourceConfig: config,
                    channelIds: [preloadPlan.channelId],
                    env: process.env,
                  })
                : resolveConfiguredChannelPluginIds({
                    config,
                    activationSourceConfig: config,
                    env: process.env,
                  });
              const activatedConfig = withActivatedPluginIds({ config, pluginIds }) ?? config;
              pluginRegistry = loadPluginRegistryHandle({
                config: activatedConfig,
                activationSourceConfig: activatedConfig,
                onlyPluginIds: pluginIds,
                throwOnLoadError: true,
              });
            }
            const deps = createDefaultDeps();
            const run = () =>
              messageCommand(
                {
                  ...normalizeMessageOptions(opts),
                  action,
                },
                deps,
                defaultRuntime,
              );
            result = await withPluginRuntimeRegistryScope(pluginRegistry, run);
          },
          (err) => {
            failed = true;
            defaultRuntime.error(danger(formatErrorMessage(err)));
          },
        );
      } finally {
        // Finalize only this command's registry, including JSON/expected errors that rethrow.
        if (pluginRegistry && action !== "read") {
          await runPluginStopHooks(pluginRegistry);
        }
      }
      failed ||= result !== undefined && !resolveMessageActionOutcome(result).ok;
      requestExitAfterOneShotOutput(defaultRuntime, failed ? 1 : 0);
    },
  };
}
