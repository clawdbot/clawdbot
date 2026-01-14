import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import { buildMessageCliJson, formatMessageCliText } from "./message-format.js";

export async function messageCommand(
  opts: Record<string, unknown>,
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const rawAction =
    typeof opts.action === "string" ? opts.action.trim().toLowerCase() : "";
  const action = (rawAction || "send") as ChannelMessageActionName;
  if (!(CHANNEL_MESSAGE_ACTION_NAMES as readonly string[]).includes(action)) {
    throw new Error(`Unknown message action: ${action}`);
  }

  const outboundDeps: OutboundSendDeps = {
    sendWhatsApp: deps.sendMessageWhatsApp,
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
    sendMSTeams: (to, text, opts) =>
      deps.sendMessageMSTeams({ cfg, to, text, mediaUrl: opts?.mediaUrl }),
  };

  const run = async () =>
    await runMessageAction({
      cfg,
      action,
      params: opts,
      deps: outboundDeps,
      gateway: {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    });

  const json = opts.json === true;
  const dryRun = opts.dryRun === true;
  const needsSpinner =
    !json && !dryRun && (action === "send" || action === "poll");

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
    runtime.log(JSON.stringify(buildMessageCliJson(result), null, 2));
    return;
  }

  for (const line of formatMessageCliText(result)) {
    runtime.log(line);
  }
}
