import { expectDefined } from "@openclaw/normalization-core";
// Outbound envelopes wrap payload projections, metadata, and delivery JSON for
// tool responses while flattening simple delivery-only results.
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OutboundDeliveryJson } from "./format.js";
import { normalizeOutboundPayloadsForJson, type OutboundPayloadJson } from "./payloads.js";

/** Structured result returned by outbound helpers when payloads/meta wrap delivery data. */
type OutboundResultEnvelope = {
  payloads?: OutboundPayloadJson[];
  meta?: unknown;
  delivery?: OutboundDeliveryJson;
};

type BuildEnvelopeParams = {
  payloads?: readonly ReplyPayload[] | readonly OutboundPayloadJson[];
  meta?: unknown;
  delivery?: OutboundDeliveryJson;
  flattenDelivery?: boolean;
};

const isOutboundPayloadJson = (
  payload: ReplyPayload | OutboundPayloadJson,
): payload is OutboundPayloadJson => "mediaUrl" in payload;

/** Builds the outbound result envelope, flattening plain delivery-only results by default. */
export function buildOutboundResultEnvelope(
  params: BuildEnvelopeParams,
): OutboundResultEnvelope | OutboundDeliveryJson {
  const hasPayloads = params.payloads !== undefined;
  const payloads =
    params.payloads === undefined
      ? undefined
      : params.payloads.length === 0
        ? []
        : isOutboundPayloadJson(expectDefined(params.payloads[0], "payloads entry at 0"))
          ? [...(params.payloads as readonly OutboundPayloadJson[])]
          : normalizeOutboundPayloadsForJson(params.payloads as readonly ReplyPayload[]);

  if (params.flattenDelivery !== false && params.delivery && !params.meta && !hasPayloads) {
    return params.delivery;
  }

  return {
    ...(hasPayloads ? { payloads } : {}),
    ...(params.meta ? { meta: params.meta } : {}),
    ...(params.delivery ? { delivery: params.delivery } : {}),
  };
}
