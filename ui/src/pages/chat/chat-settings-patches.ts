import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchResult } from "../../api/types.ts";
import {
  resolveSessionKey,
  type SessionCapability,
  type SessionPatch,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";

type ChatPickerPatchHost = SessionScopeHost & { sessions: SessionCapability };
type ChatCommandSettingsContext = {
  sessions: SessionCapability;
  defaultAgentId?: string;
  agentId?: string;
};
const pendingChatPickerPatches = new WeakMap<SessionCapability, Map<string, Promise<boolean>>>();

function resolveChatPickerPatchKey(
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): string {
  const normalizedKey = normalizeSessionKeyForUiComparison(sessionKey);
  const match = /^agent:([^:]+):(.*)$/u.exec(normalizedKey);
  const body = match?.[2] ?? normalizedKey;
  const isGlobal = isUiGlobalSessionKey(sessionKey);
  const isMainAlias = [DEFAULT_MAIN_KEY, resolveUiConfiguredMainKey(host)].includes(
    body.toLowerCase(),
  );
  const defaultAgentId = resolveUiDefaultAgentId(host);
  const parsedAgentId = match?.[1];
  // Match the Gateway's legacy default-main remap only when the live agent
  // catalog proves that "main" is not a real agent.
  const isLegacyDefaultMainAlias =
    isMainAlias &&
    normalizeAgentId(parsedAgentId ?? "") === DEFAULT_AGENT_ID &&
    defaultAgentId !== DEFAULT_AGENT_ID &&
    host.agentsList?.agents != null &&
    !host.agentsList.agents.some(
      (candidate) => normalizeAgentId(candidate.id) === DEFAULT_AGENT_ID,
    );
  // Main aliases share the literal global store only in global session scope.
  const isGlobalMain = host.agentsList?.scope
    ? host.agentsList.scope === "global"
    : isUiGlobalSessionKey(resolveSessionKey(DEFAULT_MAIN_KEY, host.hello));
  const resolvedAgentId =
    (isLegacyDefaultMainAlias ? defaultAgentId : agentId?.trim() || parsedAgentId) ||
    (isGlobal ? resolveUiSelectedGlobalAgentId(host) : defaultAgentId);
  const settingsKey =
    isGlobal || (isMainAlias && isGlobalMain) ? "global" : isMainAlias ? DEFAULT_MAIN_KEY : body;
  return `agent:${normalizeAgentId(resolvedAgentId)}:${settingsKey}`;
}

export function getPendingChatPickerPatch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): Promise<boolean> | undefined {
  const patchKey = resolveChatPickerPatchKey(host, sessionKey, agentId);
  return pendingChatPickerPatches.get(host.sessions)?.get(patchKey);
}

function trackPendingChatSettingsPatch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  patchPromise: Promise<boolean>,
  agentId?: string,
): void {
  const pendingBySession =
    pendingChatPickerPatches.get(host.sessions) ?? new Map<string, Promise<boolean>>();
  pendingChatPickerPatches.set(host.sessions, pendingBySession);
  const patchKey = resolveChatPickerPatchKey(host, sessionKey, agentId);
  pendingBySession.set(patchKey, patchPromise);
  void patchPromise.finally(() => {
    if (pendingBySession.get(patchKey) === patchPromise) {
      pendingBySession.delete(patchKey);
    }
  });
}

export function patchChatSessionSettings(
  host: ChatPickerPatchHost,
  sessionKey: string,
  patch: SessionPatch,
  options: {
    agentId?: string;
    ownsModelOverride?: () => boolean;
    reconcile?: (result: SessionsPatchResult) => Promise<void> | void;
  } = {},
): Promise<SessionsPatchResult | null> {
  const previous = getPendingChatPickerPatch(host, sessionKey, options.agentId);
  const operation = (async () => {
    // Run-affecting settings and sends share this canonical per-session tail.
    // The capability captures this route before waiting, so a reconnect cannot
    // redirect queued intent to a replacement Gateway.
    const result = await host.sessions.patch(sessionKey, patch, {
      agentId: options.agentId,
      ownsModelOverride: options.ownsModelOverride,
      waitFor: previous,
    });
    if (result) {
      await options.reconcile?.(result);
    }
    return result;
  })();
  trackPendingChatSettingsPatch(
    host,
    sessionKey,
    operation.then(
      (result) => result !== null,
      () => false,
    ),
    options.agentId,
  );
  return operation;
}

export function selectedGlobalScope(
  sessionKey: string,
  context: Pick<ChatCommandSettingsContext, "agentId">,
): { agentId?: string } {
  const normalizedSessionKey = normalizeOptionalLowercaseString(sessionKey);
  const parsed = parseAgentSessionKey(normalizedSessionKey ?? "");
  const aliasAgentId =
    parsed &&
    parsed.agentId !== DEFAULT_AGENT_ID &&
    (parsed.rest === DEFAULT_MAIN_KEY || parsed.rest === "global")
      ? parsed.agentId
      : undefined;
  const agentId = aliasAgentId ?? normalizeOptionalLowercaseString(context.agentId);
  return (normalizedSessionKey === "global" || aliasAgentId) && agentId ? { agentId } : {};
}

export async function patchChatCommandSessionSettings(
  context: ChatCommandSettingsContext,
  sessionKey: string,
  patch: SessionPatch,
  options: {
    ownsModelOverride?: () => boolean;
    reconcile?: (result: SessionsPatchResult) => Promise<void> | void;
  } = {},
): Promise<NonNullable<Awaited<ReturnType<SessionCapability["patch"]>>>> {
  const result = await patchChatSessionSettings(
    {
      sessions: context.sessions,
      assistantAgentId: context.agentId,
      agentsList: context.defaultAgentId ? { defaultId: context.defaultAgentId } : null,
      hello: null,
    },
    sessionKey,
    patch,
    { ...selectedGlobalScope(sessionKey, context), ...options },
  );
  if (!result) {
    throw new Error("Session capability is unavailable");
  }
  return result;
}
