import {
  getChannelPlugin,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import type { CliDeps } from "../../cli/deps.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "../../infra/outbound/payloads.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  isInternalMessageChannel,
  resolveGatewayMessageChannel,
} from "../../utils/message-channel.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<
  ReturnType<typeof import("../../agents/pi-embedded.js")["runEmbeddedPiAgent"]>
>;

export async function deliverAgentCommandResult(params: {
  cfg: ClawdbotConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: RunResult["payloads"];
}) {
  const { cfg, deps, runtime, opts, sessionEntry, payloads, result } = params;
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const deliveryChannel =
    resolveGatewayMessageChannel(opts.channel) ?? DEFAULT_CHAT_CHANNEL;
  // Channel docking: delivery channels are resolved via plugin registry.
  const deliveryPlugin = !isInternalMessageChannel(deliveryChannel)
    ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel)
    : undefined;

  const isDeliveryChannelKnown =
    isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);

  const targetMode: ChannelOutboundTargetMode =
    opts.deliveryTargetMode ?? (opts.to ? "explicit" : "implicit");
  const resolvedTarget =
    deliver && isDeliveryChannelKnown && deliveryChannel
      ? resolveOutboundTarget({
          channel: deliveryChannel,
          to: opts.to,
          cfg,
          accountId:
            targetMode === "implicit" ? sessionEntry?.lastAccountId : undefined,
          mode: targetMode,
        })
      : null;
  const deliveryTarget = resolvedTarget?.ok ? resolvedTarget.to : undefined;

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) runtime.log(message);
  };

  if (deliver) {
    if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    } else if (resolvedTarget && !resolvedTarget.ok) {
      if (!bestEffortDeliver) throw resolvedTarget.error;
      logDeliveryError(resolvedTarget.error);
    }
  }

  const normalizedPayloads = normalizeOutboundPayloadsForJson(payloads ?? []);
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          payloads: normalizedPayloads,
          meta: result.meta,
        }),
        null,
        2,
      ),
    );
    if (!deliver) return { payloads: normalizedPayloads, meta: result.meta };
  }

  if (!payloads || payloads.length === 0) {
    runtime.log("No reply from agent.");
    return { payloads: [], meta: result.meta };
  }

  const deliveryPayloads = normalizeOutboundPayloads(payloads);
  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) return;
    const output = formatOutboundPayloadLog(payload);
    if (output) runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) logPayload(payload);
  }
  if (
    deliver &&
    deliveryChannel &&
    !isInternalMessageChannel(deliveryChannel)
  ) {
    if (deliveryTarget) {
      await deliverOutboundPayloads({
        cfg,
        channel: deliveryChannel,
        to: deliveryTarget,
        payloads: deliveryPayloads,
        bestEffort: bestEffortDeliver,
        onError: (err) => logDeliveryError(err),
        onPayload: logPayload,
        deps: createOutboundSendDeps(deps, cfg),
      });
    }
  }

  return { payloads: normalizedPayloads, meta: result.meta };
}
