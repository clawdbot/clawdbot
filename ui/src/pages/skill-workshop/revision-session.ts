import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { loadSettings } from "../../app/settings.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { SkillWorkshopProposal } from "./page-types.ts";
import type { SkillWorkshopState } from "./proposals.ts";
import type { SkillWorkshopPageContext } from "./source-scope.ts";

function findRevisionSessionRow(
  result: SessionsListResult | null,
  sessionKey: string | undefined,
): GatewaySessionRow | null {
  const key = sessionKey?.trim();
  return key ? (result?.sessions.find((row) => row.key === key) ?? null) : null;
}

function isUsableRevisionSession(row: GatewaySessionRow | null): row is GatewaySessionRow {
  return Boolean(row && !row.archived && !row.hasActiveRun);
}

async function loadRevisionSessionsForAgent(
  context: SkillWorkshopPageContext,
  agentId: string,
): Promise<SessionsListResult | null> {
  const current = context.sessions.state;
  if (current.agentId === agentId && current.result?.sessions.length) {
    return current.result;
  }
  return context.sessions.list({ agentId });
}

export async function resolveSkillWorkshopRevisionSessionKey(
  state: SkillWorkshopState,
  context: SkillWorkshopPageContext,
  proposal: SkillWorkshopProposal,
  proposalAgentId: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  if (!isCurrent()) {
    return null;
  }
  const gatewayHello = context.gateway.snapshot.hello;
  if (state.skillWorkshopUseCurrentChatForRevisions) {
    return resolveSessionKey(loadSettings().sessionKey, gatewayHello).trim() || null;
  }

  const agentId = normalizeAgentId(proposal.origin?.agentId ?? proposalAgentId);
  const sessions = await loadRevisionSessionsForAgent(context, agentId);
  if (!isCurrent()) {
    return null;
  }
  const originRow = findRevisionSessionRow(sessions, proposal.origin?.sessionKey);
  if (isUsableRevisionSession(originRow)) {
    return originRow.key;
  }

  const createParams = {
    agentId,
    label: truncateUtf16Safe(`Skill Workshop: ${proposal.slug || proposal.key}`, 80),
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
  const sessionKey = resolveSessionKey(createdKey, gatewayHello).trim();
  if (!sessionKey) {
    throw new Error(context.sessions.state.error ?? "Could not prepare a Skill Workshop thread.");
  }
  return sessionKey;
}
