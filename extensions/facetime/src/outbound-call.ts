import { asRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isAuthorizedFaceTimeHandle,
  isVerifiedFaceTimeTransportEvidence,
  type FaceTimeCallStatusEvent,
} from "./call-events.js";

const FACETIME_DIAL_MODES = ["audio", "video"] as const;
export type FaceTimeDialMode = (typeof FACETIME_DIAL_MODES)[number];

export type FaceTimeDialRequest = {
  handle: string;
  mode: FaceTimeDialMode;
};

export type FaceTimeDialResult = FaceTimeDialRequest & {
  dialID: string;
  state: "pending" | "ringing";
  callUUID?: string;
  proxyIdentifier?: string;
  helper: Record<string, unknown>;
};

export type PendingFaceTimeDial = FaceTimeDialRequest & {
  version: 1;
  ownerEpoch: number;
  dialID: string;
  delivery: "in-flight" | "accepted" | "ambiguous" | "cancelling";
  requestedAt: string;
  callUUID?: string;
  callUUIDAliases?: Set<string>;
  proxyIdentifier?: string;
};

type FaceTimeOutboundIdentityEvent = {
  event: "ft-outbound-call-identified";
  data: {
    dial_id: string;
    call_uuid?: string;
    proxy_identifier?: string;
  };
};

export function normalizeFaceTimeOutboundIdentityEvent(
  value: unknown,
): FaceTimeOutboundIdentityEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = asRecord(value);
  if (record.event !== "ft-outbound-call-identified") {
    return undefined;
  }
  const data = asRecord(record.data);
  const dialID = normalizeOptionalString(data.dial_id);
  if (!dialID) {
    return undefined;
  }
  const callUUID = normalizeOptionalString(data.call_uuid);
  const proxyIdentifier = normalizeOptionalString(data.proxy_identifier);
  if (!callUUID && !proxyIdentifier) {
    return undefined;
  }
  return {
    event: "ft-outbound-call-identified",
    data: {
      dial_id: dialID,
      ...(callUUID ? { call_uuid: callUUID } : {}),
      ...(proxyIdentifier ? { proxy_identifier: proxyIdentifier } : {}),
    },
  };
}

function readHandle(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("handle must be a string");
  }
  const handle = value.trim();
  if (!handle) {
    throw new Error("handle is required");
  }
  if (handle.length > 320) {
    throw new Error("handle is too long");
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(handle)) {
    throw new Error("handle must not include a URL scheme");
  }
  for (const character of handle) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || "/?#\\".includes(character)) {
      throw new Error("handle contains unsupported characters");
    }
  }
  if (handle.includes("@")) {
    if (!/^[^@\s]+@[^@\s]+$/u.test(handle)) {
      throw new Error("handle must be a valid FaceTime email address or phone number");
    }
    return handle;
  }
  if (!/^[+\d\s().-]+$/u.test(handle) || !/\d/u.test(handle)) {
    throw new Error("handle must be a valid FaceTime email address or phone number");
  }
  return handle;
}

function readMode(value: unknown): FaceTimeDialMode {
  if (value === undefined) {
    return "audio";
  }
  if (value === "audio" || value === "video") {
    return value;
  }
  throw new Error("mode must be audio or video");
}

export function resolveFaceTimeDialRequest(params: {
  handle: unknown;
  mode?: unknown;
  ownerHandles: readonly string[];
}): FaceTimeDialRequest {
  const handle = readHandle(params.handle);
  if (!isAuthorizedFaceTimeHandle({ handle, ownerHandles: params.ownerHandles })) {
    throw new Error("outbound FaceTime handle is not an authorized owner handle");
  }
  return { handle, mode: readMode(params.mode) };
}

export function resolveFaceTimeDialResult(params: {
  dialID: string;
  request: FaceTimeDialRequest;
  helper: Record<string, unknown>;
}): FaceTimeDialResult {
  if (
    params.helper.muted !== true ||
    params.helper.is_uplink_muted !== true ||
    !isVerifiedFaceTimeTransportEvidence(params.helper.transport)
  ) {
    throw new Error("FaceTime helper did not prove a safely muted FaceTime outbound carrier");
  }
  const callUUID = normalizeOptionalString(params.helper.call_uuid);
  const proxyIdentifier = normalizeOptionalString(params.helper.proxy_identifier);
  return {
    ...params.request,
    dialID: params.dialID,
    state: callUUID ? "ringing" : "pending",
    ...(callUUID ? { callUUID } : {}),
    ...(proxyIdentifier ? { proxyIdentifier } : {}),
    helper: params.helper,
  };
}

export function doesFaceTimeCallMatchPendingDial(params: {
  event: FaceTimeCallStatusEvent;
  pending: PendingFaceTimeDial;
}): boolean {
  if (params.event.data.dial_id) {
    return params.event.data.dial_id === params.pending.dialID;
  }
  if (params.pending.callUUID) {
    const eventCallUUID = params.event.data.call_uuid;
    return (
      typeof eventCallUUID === "string" &&
      doesPendingFaceTimeDialHaveCallUUID(params.pending, eventCallUUID)
    );
  }
  if (params.pending.proxyIdentifier) {
    return params.event.data.proxy_identifier === params.pending.proxyIdentifier;
  }
  return params.event.data.dial_id === params.pending.dialID;
}

export function retainFaceTimeDialCallUUID(
  pending: PendingFaceTimeDial,
  callUUID: string | undefined,
): void {
  if (!callUUID) {
    return;
  }
  pending.callUUIDAliases ??= new Set<string>();
  if (pending.callUUID) {
    pending.callUUIDAliases.add(pending.callUUID);
  }
  pending.callUUIDAliases.add(callUUID);
  pending.callUUID = callUUID;
}

export function doesPendingFaceTimeDialHaveCallUUID(
  pending: PendingFaceTimeDial,
  callUUID: string,
): boolean {
  return pending.callUUID === callUUID || pending.callUUIDAliases?.has(callUUID) === true;
}
