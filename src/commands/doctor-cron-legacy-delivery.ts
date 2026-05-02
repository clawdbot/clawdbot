import { z } from "zod";
import {
  DeliveryThreadIdFieldSchema,
  LowercaseNonEmptyStringFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
  parseOptionalField,
} from "../cron/delivery-field-schemas.js";

function parseLegacyDeliveryHintsInput(payload: Record<string, unknown>) {
  return {
    deliver: parseOptionalField(z.boolean(), payload.deliver),
    bestEffortDeliver: parseOptionalField(z.boolean(), payload.bestEffortDeliver),
    channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.channel),
    provider: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.provider),
    to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, payload.to),
    threadId: parseOptionalField(
      DeliveryThreadIdFieldSchema.transform((value) => String(value)),
      payload.threadId,
    ),
  };
}

export function hasLegacyDeliveryHints(payload: Record<string, unknown>) {
  const hints = parseLegacyDeliveryHintsInput(payload);
  return (
    hints.deliver !== undefined ||
    hints.bestEffortDeliver !== undefined ||
    hints.channel !== undefined ||
    hints.provider !== undefined ||
    hints.to !== undefined ||
    hints.threadId !== undefined
  );
}

export function buildDeliveryFromLegacyPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const hints = parseLegacyDeliveryHintsInput(payload);
  const mode = hints.deliver === false ? "none" : "announce";
  const next: Record<string, unknown> = { mode };
  if (hints.channel ?? hints.provider) {
    next.channel = hints.channel ?? hints.provider;
  }
  if (hints.to) {
    next.to = hints.to;
  }
  if (hints.threadId) {
    next.threadId = hints.threadId;
  }
  if (hints.bestEffortDeliver !== undefined) {
    next.bestEffort = hints.bestEffortDeliver;
  }
  return next;
}

export function buildDeliveryPatchFromLegacyPayload(payload: Record<string, unknown>) {
  const hints = parseLegacyDeliveryHintsInput(payload);
  const next: Record<string, unknown> = {};
  let hasPatch = false;

  if (hints.deliver === false) {
    next.mode = "none";
    hasPatch = true;
  } else if (
    hints.deliver === true ||
    hints.channel ||
    hints.provider ||
    hints.to ||
    hints.threadId ||
    hints.bestEffortDeliver !== undefined
  ) {
    next.mode = "announce";
    hasPatch = true;
  }
  if (hints.channel ?? hints.provider) {
    next.channel = hints.channel ?? hints.provider;
    hasPatch = true;
  }
  if (hints.to) {
    next.to = hints.to;
    hasPatch = true;
  }
  if (hints.threadId) {
    next.threadId = hints.threadId;
    hasPatch = true;
  }
  if (hints.bestEffortDeliver !== undefined) {
    next.bestEffort = hints.bestEffortDeliver;
    hasPatch = true;
  }

  return hasPatch ? next : null;
}

export function mergeLegacyDeliveryInto(
  delivery: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const patch = buildDeliveryPatchFromLegacyPayload(payload);
  if (!patch) {
    return { delivery, mutated: false };
  }

  const next = { ...delivery };
  let mutated = false;

  if ("mode" in patch && patch.mode !== next.mode) {
    next.mode = patch.mode;
    mutated = true;
  }
  if ("channel" in patch && patch.channel !== next.channel) {
    next.channel = patch.channel;
    mutated = true;
  }
  if ("to" in patch && patch.to !== next.to) {
    next.to = patch.to;
    mutated = true;
  }
  if ("threadId" in patch && patch.threadId !== next.threadId) {
    next.threadId = patch.threadId;
    mutated = true;
  }
  if ("bestEffort" in patch && patch.bestEffort !== next.bestEffort) {
    next.bestEffort = patch.bestEffort;
    mutated = true;
  }

  return { delivery: next, mutated };
}

export function normalizeLegacyDeliveryInput(params: {
  delivery?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}) {
  if (!params.payload || !hasLegacyDeliveryHints(params.payload)) {
    return {
      delivery: params.delivery ?? undefined,
      mutated: false,
    };
  }

  const nextDelivery = params.delivery
    ? mergeLegacyDeliveryInto(params.delivery, params.payload)
    : {
        delivery: buildDeliveryFromLegacyPayload(params.payload),
        mutated: true,
      };
  stripLegacyDeliveryFields(params.payload);
  return {
    delivery: nextDelivery.delivery,
    mutated: true,
  };
}

function stripLegacyDeliveryFields(payload: Record<string, unknown>) {
  if ("deliver" in payload) {
    delete payload.deliver;
  }
  if ("channel" in payload) {
    delete payload.channel;
  }
  if ("provider" in payload) {
    delete payload.provider;
  }
  if ("to" in payload) {
    delete payload.to;
  }
  if ("threadId" in payload) {
    delete payload.threadId;
  }
  if ("bestEffortDeliver" in payload) {
    delete payload.bestEffortDeliver;
  }
}
