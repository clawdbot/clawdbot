import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Guard } from "typebox/guard";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { hasTerminalControl } from "../../packages/terminal-core/src/safe-text.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

const RESUME_HANDOFF_MAX_ENCODED_LENGTH = 4096;
const RESUME_HANDOFF_MAX_GATEWAY_URL_LENGTH = 2048;
const RESUME_HANDOFF_KEYS = ["version", "sessionKey", "gatewayUrl"] as const;
const RESUME_HANDOFF_ERROR = "Invalid --handoff payload. Copy a fresh command from the Control UI.";

type ResumeHandoff = {
  version: 1;
  sessionKey: string;
  gatewayUrl: string;
};

function invalidResumeHandoff(): never {
  throw new Error(RESUME_HANDOFF_ERROR);
}

function validateGatewayUrl(gatewayUrl: string): void {
  if (
    gatewayUrl.length === 0 ||
    gatewayUrl.length > RESUME_HANDOFF_MAX_GATEWAY_URL_LENGTH ||
    hasTerminalControl(gatewayUrl)
  ) {
    invalidResumeHandoff();
  }
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    invalidResumeHandoff();
  }
  const authority = gatewayUrl.slice(gatewayUrl.indexOf("://") + 3).split("/", 1)[0] ?? "";
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    gatewayUrl.includes("?") ||
    gatewayUrl.includes("#") ||
    authority.includes("@") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    invalidResumeHandoff();
  }
}

function validateResumeHandoffFields(sessionKey: string, gatewayUrl: string): void {
  if (
    sessionKey.length === 0 ||
    !Guard.IsMaxLength(sessionKey, CHAT_SEND_SESSION_KEY_MAX_LENGTH) ||
    hasTerminalControl(sessionKey) ||
    parseAgentSessionKey(sessionKey) === null
  ) {
    invalidResumeHandoff();
  }
  validateGatewayUrl(gatewayUrl);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(encoded: string): Uint8Array {
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (standard.length % 4)) % 4;
  const binary = atob(`${standard}${"=".repeat(paddingLength)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeResumeHandoff(input: { sessionKey: string; gatewayUrl: string }): string {
  validateResumeHandoffFields(input.sessionKey, input.gatewayUrl);
  const payload: ResumeHandoff = {
    version: 1,
    sessionKey: input.sessionKey,
    gatewayUrl: input.gatewayUrl,
  };
  const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  if (encoded.length > RESUME_HANDOFF_MAX_ENCODED_LENGTH) {
    invalidResumeHandoff();
  }
  return encoded;
}

export function decodeResumeHandoff(encoded: string): ResumeHandoff {
  try {
    if (
      encoded.length === 0 ||
      encoded.length > RESUME_HANDOFF_MAX_ENCODED_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(encoded)
    ) {
      invalidResumeHandoff();
    }
    const bytes = decodeBase64Url(encoded);
    if (encodeBase64Url(bytes) !== encoded) {
      invalidResumeHandoff();
    }
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const payload: unknown = JSON.parse(json);
    if (!isRecord(payload)) {
      invalidResumeHandoff();
    }
    const keys = Object.keys(payload);
    if (
      keys.length !== RESUME_HANDOFF_KEYS.length ||
      !RESUME_HANDOFF_KEYS.every((key) => Object.hasOwn(payload, key)) ||
      payload.version !== 1 ||
      typeof payload.sessionKey !== "string" ||
      typeof payload.gatewayUrl !== "string"
    ) {
      invalidResumeHandoff();
    }
    validateResumeHandoffFields(payload.sessionKey, payload.gatewayUrl);
    return {
      version: 1,
      sessionKey: payload.sessionKey,
      gatewayUrl: payload.gatewayUrl,
    };
  } catch {
    return invalidResumeHandoff();
  }
}
