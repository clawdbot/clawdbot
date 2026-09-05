import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytes } from "./canonical.js";
import { decodeUtf8, hex, utf8 } from "./encoding.js";

export const REEF_FEDERATION_NAMESPACE = "openclaw.session-federation.v1";
export const REEF_FEDERATION_TEXT_MAX_BYTES = 512;

type PromptFrameBinding = {
  mountId: string;
  proposalId: string;
  sessionId: string;
};

export type ReefFederationFrame =
  | {
      type: "session.mount.offer";
      mountId: string;
      sessionKey: string;
      sessionId: string;
      grantGeneration: number;
    }
  | (PromptFrameBinding & {
      type: "session.prompt.propose";
      grantGeneration: number;
      text: string;
      textSha256: string;
    })
  | (PromptFrameBinding & {
      type: "session.prompt.accepted";
      runId: string;
    })
  | (PromptFrameBinding & {
      type: "session.prompt.denied";
      reason: "host-denied" | "grant-revoked" | "stale-session";
    })
  | (PromptFrameBinding & {
      type: "session.prompt.failed";
      code: string;
      message: string;
    })
  | {
      type: "session.grant.revoked";
      mountId: string;
      sessionId: string;
      grantGeneration: number;
    };

export type ReefFederationBody = {
  namespace: typeof REEF_FEDERATION_NAMESPACE;
  frame: ReefFederationFrame;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Build the digest that binds a proposed prompt to its exact transport and session authority. */
export function createReefFederatedPromptDigest(params: {
  from: string;
  to: string;
  mountId: string;
  proposalId: string;
  sessionId: string;
  grantGeneration: number;
  text: string;
}): string {
  return hex(
    sha256(
      canonicalBytes({
        namespace: REEF_FEDERATION_NAMESPACE,
        type: "session.prompt.propose",
        ...params,
      }),
    ),
  );
}

/** Return whether an opened Reef body belongs to the session-federation namespace. */
export function isReefFederationBody(value: unknown): value is ReefFederationBody {
  return (
    isFederationRecord(value) &&
    value.namespace === REEF_FEDERATION_NAMESPACE &&
    Object.keys(value).length === 2 &&
    "frame" in value
  );
}

/** Validate a bounded, exact session-federation body before it reaches runtime logic. */
export function validateReefFederationBody(value: unknown): asserts value is ReefFederationBody {
  if (!isReefFederationBody(value) || !isFederationRecord(value.frame)) {
    throw new Error("invalid federation body");
  }
  const frame = value.frame;
  switch (frame.type) {
    case "session.mount.offer":
      assertExactKeys(frame, ["type", "mountId", "sessionKey", "sessionId", "grantGeneration"]);
      assertId(frame.mountId, "mount id");
      assertBoundedText(frame.sessionKey, 256, "session key");
      assertId(frame.sessionId, "session id");
      assertGeneration(frame.grantGeneration);
      return;
    case "session.prompt.propose":
      assertExactKeys(frame, [
        "type",
        "mountId",
        "proposalId",
        "sessionId",
        "grantGeneration",
        "text",
        "textSha256",
      ]);
      assertPromptBinding(frame);
      assertGeneration(frame.grantGeneration);
      assertBoundedText(frame.text, REEF_FEDERATION_TEXT_MAX_BYTES, "prompt text");
      if (typeof frame.textSha256 !== "string" || !SHA256_PATTERN.test(frame.textSha256)) {
        throw new Error("invalid prompt digest");
      }
      return;
    case "session.prompt.accepted":
      assertExactKeys(frame, ["type", "mountId", "proposalId", "sessionId", "runId"]);
      assertPromptBinding(frame);
      assertId(frame.runId, "run id");
      return;
    case "session.prompt.denied":
      assertExactKeys(frame, ["type", "mountId", "proposalId", "sessionId", "reason"]);
      assertPromptBinding(frame);
      if (!new Set(["host-denied", "grant-revoked", "stale-session"]).has(frame.reason)) {
        throw new Error("invalid denial reason");
      }
      return;
    case "session.prompt.failed":
      assertExactKeys(frame, ["type", "mountId", "proposalId", "sessionId", "code", "message"]);
      assertPromptBinding(frame);
      assertId(frame.code, "failure code");
      assertBoundedText(frame.message, 512, "failure message");
      return;
    case "session.grant.revoked":
      assertExactKeys(frame, ["type", "mountId", "sessionId", "grantGeneration"]);
      assertId(frame.mountId, "mount id");
      assertId(frame.sessionId, "session id");
      assertGeneration(frame.grantGeneration);
      return;
    default:
      throw new Error("unknown federation frame");
  }
}

function assertPromptBinding(value: Record<string, unknown>): void {
  assertId(value.mountId, "mount id");
  assertId(value.proposalId, "proposal id");
  assertId(value.sessionId, "session id");
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`invalid ${label}`);
  }
}

function assertGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("invalid grant generation");
  }
}

function assertBoundedText(
  value: unknown,
  maxBytes: number,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || utf8(value).length > maxBytes) {
    throw new Error(`invalid ${label}`);
  }
  if (decodeUtf8(utf8(value)) !== value) {
    throw new Error(`invalid UTF-8 ${label}`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error("invalid federation frame fields");
  }
}

function isFederationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
