import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const VERIFICATION_EVENT_PREFIX = "m.key.verification.";
const VERIFICATION_REQUEST_MSGTYPE = "m.key.verification.request";

const VERIFICATION_NOTICE_PREFIXES = [
  "Matrix verification request received from ",
  "Matrix verification is ready with ",
  "Matrix verification started with ",
  "Matrix verification completed with ",
  "Matrix verification cancelled by ",
  "Matrix verification SAS with ",
];

function trimMaybeString(input: unknown): string {
  return normalizeOptionalString(input) ?? "";
}

export function isMatrixVerificationEventType(type: unknown): boolean {
  return trimMaybeString(type).startsWith(VERIFICATION_EVENT_PREFIX);
}

export function isMatrixVerificationRequestMsgType(msgtype: unknown): boolean {
  return trimMaybeString(msgtype) === VERIFICATION_REQUEST_MSGTYPE;
}

export function isMatrixVerificationNoticeBody(body: unknown): boolean {
  const text = trimMaybeString(body);
  return VERIFICATION_NOTICE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function isMatrixVerificationRoomMessage(content: {
  msgtype?: unknown;
  body?: unknown;
}): boolean {
  return (
    isMatrixVerificationRequestMsgType(content.msgtype) ||
    (trimMaybeString(content.msgtype) === "m.notice" &&
      isMatrixVerificationNoticeBody(content.body))
  );
}

export const matrixVerificationConstants = {
  eventPrefix: VERIFICATION_EVENT_PREFIX,
  requestMsgtype: VERIFICATION_REQUEST_MSGTYPE,
} as const;
