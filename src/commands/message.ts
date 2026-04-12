import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../channels/plugins/message-action-names.js";
import type { ChannelMessageActionName } from "../channels/plugins/types.public.js";
import { resolveCommandConfigWithSecrets } from "../cli/command-config-resolution.js";
import { getScopedChannelsCommandSecretTargets } from "../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../cli/message-secret-scope.js";
import { createOutboundSendDeps, type CliDeps } from "../cli/outbound-send-deps.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { buildMessageCliJson, formatMessageCliText } from "./message-format.js";

export async function messageCommand(
  opts: Record<string, unknown>,
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const loadedRaw = loadConfig();
  const scope = resolveMessageSecretScope({
    channel: opts.channel,
    target: opts.target,
    targets: opts.targets,
    accountId: opts.accountId,
  });
  const scopedTargets = getScopedChannelsCommandSecretTargets({
    config: loadedRaw,
    channel: scope.channel,
    accountId: scope.accountId,
  });
  const { effectiveConfig: cfg } = await resolveCommandConfigWithSecrets({
    config: loadedRaw,
    commandName: "message",
    targetIds: scopedTargets.targetIds,
    ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
    runtime,
    autoEnable: true,
  });
  const rawAction = normalizeOptionalString(opts.action) ?? "";
  const actionInput = rawAction || "send";
  const normalizedActionInput = normalizeLowercaseStringOrEmpty(actionInput);
  const actionMatch = (CHANNEL_MESSAGE_ACTION_NAMES as readonly string[]).find(
    (name) => normalizeLowercaseStringOrEmpty(name) === normalizedActionInput,
  );
  if (!actionMatch) {
    throw new Error(`Unknown message action: ${actionInput}`);
  }
  const action = actionMatch as ChannelMessageActionName;

  const outboundDeps: OutboundSendDeps = createOutboundSendDeps(deps);
  const senderIsOwner = typeof opts.senderIsOwner === "boolean" ? opts.senderIsOwner : true;

  const run = async () =>
    await runMessageAction({
      cfg,
      action,
      params: opts,
      deps: outboundDeps,
      agentId: resolveDefaultAgentId(cfg),
      senderIsOwner,
      gateway: {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    });

  const json = opts.json === true;
  const dryRun = opts.dryRun === true;
  const needsSpinner = !json && !dryRun && (action === "send" || action === "poll");

  const result = needsSpinner
    ? await withProgress(
        {
          label: action === "poll" ? "Sending poll..." : "Sending...",
          indeterminate: true,
          enabled: true,
        },
        run,
      )
    : await run();

  if (json) {
    writeRuntimeJson(runtime, buildMessageCliJson(result));
    return;
  }

  for (const line of formatMessageCliText(result)) {
    runtime.log(line);
  }
}
