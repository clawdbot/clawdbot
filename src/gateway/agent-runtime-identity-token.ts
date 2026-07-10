// Purpose-scoped local agent runtime identity token for Gateway clients.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ensureExecApprovalsSnapshot, loadExecApprovals } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";

const AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT = "openclaw:gateway-agent-runtime-identity-token:v1";
const AGENT_RUNTIME_IDENTITY_TOKEN_KIND = "agent-runtime";

export type AgentRuntimeIdentity = {
  kind: "agentRuntime";
  agentId: string;
  sessionKey: string;
};

type AgentRuntimeIdentityTokenPayload = {
  kind: typeof AGENT_RUNTIME_IDENTITY_TOKEN_KIND;
  agentId: string;
  sessionKey: string;
};

function readSharedAgentRuntimeIdentitySecret(): string | null {
  return loadExecApprovals().socket?.token?.trim() || null;
}

async function requireSharedAgentRuntimeIdentitySecret(): Promise<string> {
  const token = (await ensureExecApprovalsSnapshot()).file.socket?.token?.trim();
  if (!token) {
    throw new Error(
      "Unable to mint agent runtime identity token without local socket credentials.",
    );
  }
  return token;
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

function signatureMatches(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return valueBytes.length === expectedBytes.length && timingSafeEqual(valueBytes, expectedBytes);
}

function encodePayload(payload: AgentRuntimeIdentityTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(value: string): AgentRuntimeIdentityTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const raw = parsed as {
      kind?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
    };
    if (
      raw.kind !== AGENT_RUNTIME_IDENTITY_TOKEN_KIND ||
      typeof raw.agentId !== "string" ||
      typeof raw.sessionKey !== "string"
    ) {
      return undefined;
    }
    const agentId = normalizeAgentId(raw.agentId);
    const sessionKey = raw.sessionKey.trim();
    if (!agentId || !sessionKey) {
      return undefined;
    }
    return { kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND, agentId, sessionKey };
  } catch {
    return undefined;
  }
}

/** Mint an opaque token that lets trusted local agent-tool clients identify their agent. */
export async function mintAgentRuntimeIdentityToken(params: {
  agentId: string;
  sessionKey: string;
}): Promise<string> {
  const payload = encodePayload({
    kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
    agentId: normalizeAgentId(params.agentId),
    sessionKey: params.sessionKey.trim(),
  });
  const signature = signPayload(await requireSharedAgentRuntimeIdentitySecret(), payload);
  return `${payload}.${signature}`;
}

/** Validate a presented agent runtime token and return the internal caller identity. */
export function verifyAgentRuntimeIdentityToken(
  value: string | null | undefined,
): AgentRuntimeIdentity | undefined {
  const token = value?.trim();
  if (!token) {
    return undefined;
  }
  const [payloadPart, signature, ...extra] = token.split(".");
  if (!payloadPart || !signature || extra.length > 0) {
    return undefined;
  }
  const payload = decodePayload(payloadPart);
  if (!payload) {
    return undefined;
  }
  const sharedSecret = readSharedAgentRuntimeIdentitySecret();
  if (!sharedSecret || !signatureMatches(signature, signPayload(sharedSecret, payloadPart))) {
    return undefined;
  }
  return {
    kind: "agentRuntime",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
  };
}
