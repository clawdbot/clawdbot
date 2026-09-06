import {
  asBoolean,
  asRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type FaceTimeCallStatusEvent = {
  event: "ft-call-status-changed";
  data: FaceTimeCallStatusData;
};

type FaceTimeCallStatusData = {
  audio_mode?: unknown;
  call_status?: unknown;
  call_uuid?: unknown;
  dial_id?: unknown;
  proxy_identifier?: unknown;
  conversation_group_uuid?: unknown;
  conversation_uuid?: unknown;
  conversation_audio_enabled?: unknown;
  conversation_video_enabled?: unknown;
  conversation_av_mode?: unknown;
  conversation_resolved_audio_video_mode?: unknown;
  disconnected_reason?: unknown;
  ended_error?: unknown;
  ended_reason?: unknown;
  has_ended?: unknown;
  handle?: unknown;
  is_conversation?: unknown;
  is_outgoing?: unknown;
  is_sending_audio?: unknown;
  is_sending_transmission?: unknown;
  is_sending_video?: unknown;
  is_uplink_muted?: unknown;
  local_meter_level?: unknown;
  remote_meter_level?: unknown;
  transport?: unknown;
};

// Verified against the current TelephonyUtilities TUCall state machine. Native
// ended evidence remains authoritative; every unlisted numeric state fails closed.
const TU_CALL_STATUS = {
  outgoingCreated: 0,
  active: 1,
  outgoingRinging: 3,
  incomingRinging: 4,
} as const;

type FaceTimeCallTransport =
  | {
      kind: "facetime";
      classifierVersion: "tu-provider-v1";
      service: 2 | 3;
      faceTimeTransportType?: number;
      providerClassified: true;
      providerIsFaceTime: true;
      providerIsTelephony: false;
      isUsingBaseband: false;
      isWifiCall: false;
      isVoip: true;
      isEmergency: false;
    }
  | {
      kind: "cellular" | "unknown";
      classifierVersion: "tu-provider-v1";
      service?: number;
      faceTimeTransportType?: number;
      providerClassified?: boolean;
      providerIsFaceTime?: boolean;
      providerIsTelephony?: boolean;
      isUsingBaseband?: boolean;
      isWifiCall?: boolean;
      isVoip?: boolean;
      isEmergency?: boolean;
    };

export type AuthenticatedFaceTimeOwner = {
  senderId: string;
  senderIsOwner: true;
};

function readFiniteNumber(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function normalizeCallTransport(value: unknown): FaceTimeCallTransport {
  const transport = asRecord(value);
  const base = {
    classifierVersion: "tu-provider-v1" as const,
    service: readFiniteNumber(transport.service),
    faceTimeTransportType: readFiniteNumber(
      transport.facetime_transport_type ?? transport.faceTimeTransportType,
    ),
    providerClassified: asBoolean(transport.provider_classified ?? transport.providerClassified),
    providerIsFaceTime: asBoolean(transport.provider_is_facetime ?? transport.providerIsFaceTime),
    providerIsTelephony: asBoolean(
      transport.provider_is_telephony ?? transport.providerIsTelephony,
    ),
    isUsingBaseband: asBoolean(transport.is_using_baseband ?? transport.isUsingBaseband),
    isWifiCall: asBoolean(transport.is_wifi_call ?? transport.isWifiCall),
    isVoip: asBoolean(transport.is_voip ?? transport.isVoip),
    isEmergency: asBoolean(transport.is_emergency ?? transport.isEmergency),
  };
  if (
    transport.kind === "facetime" &&
    (transport.classifier_version === "tu-provider-v1" ||
      transport.classifierVersion === "tu-provider-v1") &&
    (base.service === 2 || base.service === 3) &&
    base.providerClassified === true &&
    base.providerIsFaceTime === true &&
    base.providerIsTelephony === false &&
    base.isUsingBaseband === false &&
    base.isWifiCall === false &&
    base.isVoip === true &&
    base.isEmergency === false
  ) {
    return {
      kind: "facetime",
      classifierVersion: base.classifierVersion,
      service: base.service,
      ...(base.faceTimeTransportType !== undefined
        ? { faceTimeTransportType: base.faceTimeTransportType }
        : {}),
      providerClassified: true,
      providerIsFaceTime: true,
      providerIsTelephony: false,
      isUsingBaseband: false,
      isWifiCall: false,
      isVoip: true,
      isEmergency: false,
    };
  }
  return {
    kind: transport.kind === "cellular" ? "cellular" : "unknown",
    classifierVersion: base.classifierVersion,
    ...(base.service !== undefined ? { service: base.service } : {}),
    ...(base.faceTimeTransportType !== undefined
      ? { faceTimeTransportType: base.faceTimeTransportType }
      : {}),
    ...(base.providerClassified !== undefined
      ? { providerClassified: base.providerClassified }
      : {}),
    ...(base.providerIsFaceTime !== undefined
      ? { providerIsFaceTime: base.providerIsFaceTime }
      : {}),
    ...(base.providerIsTelephony !== undefined
      ? { providerIsTelephony: base.providerIsTelephony }
      : {}),
    ...(base.isUsingBaseband !== undefined ? { isUsingBaseband: base.isUsingBaseband } : {}),
    ...(base.isWifiCall !== undefined ? { isWifiCall: base.isWifiCall } : {}),
    ...(base.isVoip !== undefined ? { isVoip: base.isVoip } : {}),
    ...(base.isEmergency !== undefined ? { isEmergency: base.isEmergency } : {}),
  };
}

const handleValueKeys = new Set([
  "address",
  "email",
  "emailAddress",
  "handle",
  "normalizedValue",
  "phoneNumber",
  "unformattedPhoneNumber",
  "value",
]);

function collectHandleCandidates(
  value: unknown,
  candidates: string[] = [],
  seen = new Set<unknown>(),
): string[] {
  const direct = normalizeOptionalString(value);
  if (direct) {
    candidates.push(direct);
    return candidates;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return candidates;
  }
  seen.add(value);
  const record = asRecord(value);
  for (const [key, nested] of Object.entries(record)) {
    if (handleValueKeys.has(key)) {
      collectHandleCandidates(nested, candidates, seen);
    } else if (nested && typeof nested === "object") {
      collectHandleCandidates(nested, candidates, seen);
    }
  }
  return candidates;
}

function normalizeFaceTimeHandleCandidates(value: unknown): string[] {
  return [...new Set(collectHandleCandidates(value).map((candidate) => candidate.trim()))];
}

export function normalizeFaceTimeHandle(value: unknown): string | undefined {
  return normalizeFaceTimeHandleCandidates(value)[0];
}

function canonicalizeFaceTimeHandle(value: string): string {
  const stripped = value
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/^tel:/, "")
    .replace(/^facetime-audio:/, "")
    .replace(/^facetime:/, "");
  return stripped.includes("@") ? stripped : stripped.replace(/[^\d+]/g, "");
}

export function normalizeFaceTimeCallEvent(value: unknown): FaceTimeCallStatusEvent | undefined {
  const record = asRecord(value);
  if (record.event !== "ft-call-status-changed") {
    return undefined;
  }
  const data = asRecord(record.data);
  const callUUID = normalizeOptionalString(data.call_uuid);
  const proxyIdentifier = normalizeOptionalString(data.proxy_identifier);
  const conversationUUID = normalizeOptionalString(data.conversation_uuid);
  const conversationGroupUUID = normalizeOptionalString(data.conversation_group_uuid);
  const conversationAVMode =
    typeof data.conversation_av_mode === "number"
      ? data.conversation_av_mode
      : typeof data.conversation_av_mode === "string"
        ? Number(data.conversation_av_mode)
        : undefined;
  const conversationResolvedAVMode =
    typeof data.conversation_resolved_audio_video_mode === "number"
      ? data.conversation_resolved_audio_video_mode
      : typeof data.conversation_resolved_audio_video_mode === "string"
        ? Number(data.conversation_resolved_audio_video_mode)
        : undefined;
  const status =
    typeof data.call_status === "number"
      ? data.call_status
      : typeof data.call_status === "string"
        ? Number(data.call_status)
        : undefined;
  if (!callUUID || !Number.isInteger(status)) {
    return undefined;
  }
  return {
    event: "ft-call-status-changed",
    data: {
      ...data,
      call_uuid: callUUID,
      proxy_identifier: proxyIdentifier,
      call_status: status,
      conversation_uuid: conversationUUID,
      conversation_group_uuid: conversationGroupUUID,
      conversation_audio_enabled: data.conversation_audio_enabled === true,
      conversation_video_enabled: data.conversation_video_enabled === true,
      conversation_av_mode: Number.isInteger(conversationAVMode) ? conversationAVMode : undefined,
      conversation_resolved_audio_video_mode: Number.isInteger(conversationResolvedAVMode)
        ? conversationResolvedAVMode
        : undefined,
      is_outgoing: data.is_outgoing === true,
      has_ended: data.has_ended === true,
      is_sending_audio: data.is_sending_audio === true,
      is_sending_transmission: data.is_sending_transmission === true,
      is_sending_video: data.is_sending_video === true,
      is_uplink_muted: data.is_uplink_muted === true,
      local_meter_level: readFiniteNumber(data.local_meter_level),
      remote_meter_level: readFiniteNumber(data.remote_meter_level),
      transport: normalizeCallTransport(data.transport),
    },
  };
}

export function resolveAuthorizedFaceTimeOwner(params: {
  event: FaceTimeCallStatusEvent;
  ownerHandles: readonly string[];
}): AuthenticatedFaceTimeOwner | undefined {
  if (!isVerifiedFaceTimeTransport(params.event)) {
    return undefined;
  }
  const ownerHandles = new Set(params.ownerHandles.map(canonicalizeFaceTimeHandle).filter(Boolean));
  const senderId = normalizeFaceTimeHandleCandidates(params.event.data.handle)
    .map(canonicalizeFaceTimeHandle)
    .find((candidate) => ownerHandles.has(candidate));
  if (!senderId) {
    return undefined;
  }
  // Admission and owner authorization are one contract; this plugin has no guest caller tier.
  return { senderId, senderIsOwner: true };
}

export function isVerifiedFaceTimeTransport(event: FaceTimeCallStatusEvent): boolean {
  return isVerifiedFaceTimeTransportEvidence(event.data.transport);
}

export function isVerifiedFaceTimeTransportEvidence(value: unknown): boolean {
  return normalizeCallTransport(value).kind === "facetime";
}

export function isAuthorizedFaceTimeHandle(params: {
  handle: string;
  ownerHandles: readonly string[];
}): boolean {
  const canonicalHandle = canonicalizeFaceTimeHandle(params.handle);
  return (
    canonicalHandle.length > 0 &&
    params.ownerHandles.some((entry) => canonicalizeFaceTimeHandle(entry) === canonicalHandle)
  );
}

export function isIncomingRingingCall(event: FaceTimeCallStatusEvent): boolean {
  return (
    event.data.call_status === TU_CALL_STATUS.incomingRinging && event.data.is_outgoing !== true
  );
}

export function isActiveCall(event: FaceTimeCallStatusEvent): boolean {
  return event.data.call_status === TU_CALL_STATUS.active;
}

export function isOutgoingRingingCall(event: FaceTimeCallStatusEvent): boolean {
  return (
    (event.data.call_status === TU_CALL_STATUS.outgoingCreated ||
      event.data.call_status === TU_CALL_STATUS.outgoingRinging) &&
    event.data.is_outgoing === true
  );
}

export function isEndedCall(event: FaceTimeCallStatusEvent): boolean {
  return event.data.has_ended === true;
}

export function isUnknownCallStatus(event: FaceTimeCallStatusEvent): boolean {
  return (
    !isIncomingRingingCall(event) &&
    !isOutgoingRingingCall(event) &&
    !isActiveCall(event) &&
    !isEndedCall(event)
  );
}
