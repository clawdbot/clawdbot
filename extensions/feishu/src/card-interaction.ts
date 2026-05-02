import { isRecord } from "./comment-shared.js";

export const FEISHU_CARD_INTERACTION_VERSION = "ocf1";

type FeishuCardInteractionKind = "button" | "quick" | "meta";
type FeishuCardInteractionReason = "malformed" | "stale" | "wrong_user" | "wrong_conversation";

type FeishuCardInteractionMetadata = Record<string, string | number | boolean | null | undefined>;

export type FeishuCardInteractionEnvelope = {
  oc: typeof FEISHU_CARD_INTERACTION_VERSION;
  k: FeishuCardInteractionKind;
  a: string;
  q?: string;
  m?: FeishuCardInteractionMetadata;
  c?: {
    u?: string;
    h?: string;
    s?: string;
    e?: number;
    t?: "p2p" | "group";
  };
};

type FeishuCardActionEventLike = {
  operator: {
    open_id?: string;
  };
  action: {
    value: unknown;
  };
  context: {
    chat_id?: string;
  };
};

type DecodedFeishuCardAction =
  | {
      kind: "structured";
      envelope: FeishuCardInteractionEnvelope;
    }
  | {
      kind: "legacy";
      text: string;
    }
  | {
      kind: "invalid";
      reason: FeishuCardInteractionReason;
    };

function isInteractionKind(value: unknown): value is FeishuCardInteractionKind {
  return value === "button" || value === "quick" || value === "meta";
}

function isMetadataValue(value: unknown): value is string | number | boolean | null | undefined {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function createFeishuCardInteractionEnvelope(
  envelope: Omit<FeishuCardInteractionEnvelope, "oc">,
): FeishuCardInteractionEnvelope {
  return {
    oc: FEISHU_CARD_INTERACTION_VERSION,
    ...envelope,
  };
}

export function buildFeishuCardActionTextFallback(event: FeishuCardActionEventLike): string {
  const actionValue = event.action.value;
  if (isRecord(actionValue)) {
    if (typeof actionValue.text === "string") {
      return actionValue.text;
    }
    if (typeof actionValue.command === "string") {
      return actionValue.command;
    }
    return JSON.stringify(actionValue);
  }
  return String(actionValue);
}

export function decodeFeishuCardAction(params: {
  event: FeishuCardActionEventLike;
  now?: number;
}): DecodedFeishuCardAction {
  const { event, now = Date.now() } = params;
  const actionValue = event.action.value;
  if (!isRecord(actionValue) || actionValue.oc !== FEISHU_CARD_INTERACTION_VERSION) {
    return {
      kind: "legacy",
      text: buildFeishuCardActionTextFallback(event),
    };
  }

  if (!isInteractionKind(actionValue.k) || typeof actionValue.a !== "string" || !actionValue.a) {
    return { kind: "invalid", reason: "malformed" };
  }

  if (actionValue.q !== undefined && typeof actionValue.q !== "string") {
    return { kind: "invalid", reason: "malformed" };
  }

  if (actionValue.m !== undefined) {
    if (!isRecord(actionValue.m)) {
      return { kind: "invalid", reason: "malformed" };
    }
    for (const value of Object.values(actionValue.m)) {
      if (!isMetadataValue(value)) {
        return { kind: "invalid", reason: "malformed" };
      }
    }
  }

  if (actionValue.c !== undefined) {
    if (!isRecord(actionValue.c)) {
      return { kind: "invalid", reason: "malformed" };
    }
    if (actionValue.c.u !== undefined && typeof actionValue.c.u !== "string") {
      return { kind: "invalid", reason: "malformed" };
    }
    if (actionValue.c.h !== undefined && typeof actionValue.c.h !== "string") {
      return { kind: "invalid", reason: "malformed" };
    }
    if (actionValue.c.s !== undefined && typeof actionValue.c.s !== "string") {
      return { kind: "invalid", reason: "malformed" };
    }
    if (actionValue.c.e !== undefined && !Number.isFinite(actionValue.c.e)) {
      return { kind: "invalid", reason: "malformed" };
    }
    if (actionValue.c.t !== undefined && actionValue.c.t !== "p2p" && actionValue.c.t !== "group") {
      return { kind: "invalid", reason: "malformed" };
    }

    if (typeof actionValue.c.e === "number" && actionValue.c.e < now) {
      return { kind: "invalid", reason: "stale" };
    }

    const expectedUser = actionValue.c.u?.trim();
    if (expectedUser && expectedUser !== (event.operator.open_id ?? "").trim()) {
      return { kind: "invalid", reason: "wrong_user" };
    }

    const expectedChat = actionValue.c.h?.trim();
    if (expectedChat && expectedChat !== (event.context.chat_id ?? "").trim()) {
      return { kind: "invalid", reason: "wrong_conversation" };
    }
  }

  return {
    kind: "structured",
    envelope: actionValue as FeishuCardInteractionEnvelope,
  };
}
