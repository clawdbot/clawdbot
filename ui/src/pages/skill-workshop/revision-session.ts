import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SkillWorkshopRevisionAdmissionInput } from "../../app/skill-workshop-revision-admissions.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "../../lib/sessions/session-key.ts";

function findRevisionSessionRow(
  result: SessionsListResult | null,
  sessionKey: string | undefined,
): GatewaySessionRow | null {
  const key = sessionKey?.trim();
  return key
    ? (result?.sessions.find((row) => areUiSessionKeysEquivalent(row.key, key)) ?? null)
    : null;
}

function isUsableRevisionSession(row: GatewaySessionRow | null): row is GatewaySessionRow {
  return Boolean(row && !row.archived && !row.hasActiveRun);
}

async function loadRevisionSessionsForAgent(
  context: ApplicationContext,
  agentId: string,
): Promise<SessionsListResult | null> {
  const current = context.sessions.state;
  if (current.agentId === agentId && current.result?.sessions.length) {
    return current.result;
  }
  return context.sessions.list({ agentId });
}

type SkillWorkshopRevisionTarget = {
  sessionKey: string;
  sessionId?: string;
  targetAgentId: string;
};

function revisionTarget(
  sessionKey: string,
  targetAgentId: string,
  row?: GatewaySessionRow | null,
): SkillWorkshopRevisionTarget {
  const sessionId = row?.sessionId?.trim();
  return {
    sessionKey,
    targetAgentId: normalizeAgentId(row?.agentId ?? targetAgentId),
    ...(sessionId ? { sessionId } : {}),
  };
}

export async function resolveSkillWorkshopRevisionTarget(
  input: SkillWorkshopRevisionAdmissionInput,
  context: ApplicationContext,
  isCurrent: () => boolean,
): Promise<SkillWorkshopRevisionTarget | null> {
  if (!isCurrent()) {
    return null;
  }
  const gatewayHello = context.gateway.snapshot.hello;
  const agentId = normalizeAgentId(input.proposalOriginAgentId ?? input.proposalAgentId);
  const sessions = await loadRevisionSessionsForAgent(context, agentId);
  if (!isCurrent()) {
    return null;
  }
  const originRow = findRevisionSessionRow(sessions, input.proposalOriginSessionKey);
  if (isUsableRevisionSession(originRow)) {
    return revisionTarget(originRow.key, agentId, originRow);
  }

  const createParams = {
    agentId,
    label: truncateUtf16Safe(`Skill Workshop: ${input.proposalSlug || input.proposalId}`, 80),
  };
  const createAccess = readSessionMethodAccess(context.gateway.snapshot, {
    method: "sessions.create",
    params: createParams,
  });
  if (!createAccess.allowed) {
    throw new Error(createAccess.reason);
  }
  if (!isCurrent()) {
    return null;
  }
  const createdKey = await context.sessions.create(createParams);
  if (!isCurrent()) {
    return null;
  }
  const sessionKey = resolveSessionKey(createdKey, gatewayHello).trim();
  if (!sessionKey) {
    throw new Error(context.sessions.state.error ?? "Could not prepare a Skill Workshop thread.");
  }
  return revisionTarget(sessionKey, agentId);
}
