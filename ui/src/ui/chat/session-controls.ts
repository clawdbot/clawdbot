import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "../app-view-state.ts";
import { createChatModelOverride } from "../chat-model-ref.ts";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "../chat-model-select-state.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "../controllers/agents.ts";
import { loadSessions } from "../controllers/sessions.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import {
  listThinkingLevelLabels,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "../thinking.ts";
import type { GatewayThinkingLevelOption, SessionsListResult } from "../types.ts";

type ChatSessionSwitchHandler = (state: AppViewState, nextSessionKey: string) => void;

export function renderChatSessionSelect(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler = () => undefined,
) {
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const agentOptions = resolveChatAgentFilterOptions(state);
  const hasAgentSelect = agentOptions.length > 1;
  const agentSelect = renderChatAgentSelect(state, onSwitchSession, agentOptions);
  const modelSelect = renderChatModelSelect(state);
  const thinkingSelect = renderChatThinkingSelect(state);
  const selectedSessionLabel =
    sessionGroups.flatMap((group) => group.options).find((entry) => entry.key === state.sessionKey)
      ?.label ?? state.sessionKey;
  const flashSession = state.sessionSwitchFlashKey === state.sessionKey;
  const rowClass = [
    "chat-controls__session-row",
    hasAgentSelect ? "" : "chat-controls__session-row--single-agent",
    flashSession ? "chat-controls__session-row--flash" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${rowClass}>
      ${agentSelect}
      <label class="field chat-controls__session chat-controls__session-picker">
        <select
          data-chat-session-select="true"
          aria-label="Chat session"
          .value=${state.sessionKey}
          title=${selectedSessionLabel}
          ?disabled=${!state.connected || sessionGroups.length === 0}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            if (state.sessionKey === next) {
              return;
            }
            onSwitchSession(state, next);
          }}
        >
          ${repeat(
            sessionGroups,
            (group) => group.id,
            (group) =>
              html`<optgroup label=${group.label}>
                ${repeat(
                  group.options,
                  (entry) => entry.key,
                  (entry) =>
                    html`<option
                      value=${entry.key}
                      title=${entry.title}
                      ?selected=${entry.key === state.sessionKey}
                    >
                      ${entry.label}
                    </option>`,
                )}
              </optgroup>`,
          )}
        </select>
      </label>
      ${modelSelect} ${thinkingSelect}
    </div>
    <div class="chat-controls__session-notice" role="status" aria-live="polite">
      ${state.sessionSwitchNotice?.text ?? ""}
    </div>
  `;
}

function renderChatAgentSelect(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler,
  options = resolveChatAgentFilterOptions(state),
) {
  if (options.length <= 1) {
    return "";
  }
  const activeAgentId = resolveChatAgentFilterId(state, state.sessionKey);
  const selectedLabel = options.find((entry) => entry.id === activeAgentId)?.label ?? activeAgentId;
  return html`
    <label class="field chat-controls__session chat-controls__agent">
      <select
        data-chat-agent-filter="true"
        aria-label="Filter sessions by agent"
        title=${selectedLabel}
        .value=${activeAgentId}
        ?disabled=${!state.connected}
        @change=${(e: Event) => {
          const nextAgentId = normalizeAgentId((e.target as HTMLSelectElement).value);
          if (nextAgentId === activeAgentId) {
            return;
          }
          onSwitchSession(state, resolvePreferredSessionForAgent(state, nextAgentId));
        }}
      >
        ${repeat(
          options,
          (entry) => entry.id,
          (entry) =>
            html`<option value=${entry.id} ?selected=${entry.id === activeAgentId}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    activeMinutes: 0,
    limit: 0,
    includeGlobal: true,
    includeUnknown: true,
    showArchived: state.sessionsShowArchived,
  });
}

async function refreshVisibleToolsEffectiveForCurrentSessionLazy(state: AppViewState) {
  return refreshVisibleToolsEffectiveForCurrentSession(state);
}

function renderChatModelSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatModelSelectState(state);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled =
    !state.connected || busy || (state.chatModelsLoading && options.length === 0) || !state.client;
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  return html`
    <label class="field chat-controls__session chat-controls__model">
      <select
        data-chat-model-select="true"
        aria-label="Chat model"
        title=${selectedLabel}
        ?disabled=${disabled}
        @change=${async (e: Event) => {
          const next = (e.target as HTMLSelectElement).value.trim();
          await switchChatModel(state, next);
        }}
      >
        <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
        ${repeat(
          options,
          (entry) => entry.value,
          (entry) =>
            html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

type ChatThinkingSelectOption = {
  value: string;
  label: string;
};

type ChatThinkingSelectState = {
  currentOverride: string;
  defaultLabel: string;
  options: ChatThinkingSelectOption[];
};

function resolveThinkingTargetModel(state: AppViewState): {
  provider: string | null;
  model: string | null;
} {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  return {
    provider: activeRow?.modelProvider ?? state.sessionsResult?.defaults?.modelProvider ?? null,
    model: activeRow?.model ?? state.sessionsResult?.defaults?.model ?? null,
  };
}

function buildThinkingOptions(
  levels: readonly GatewayThinkingLevelOption[],
  currentOverride: string,
): ChatThinkingSelectOption[] {
  const seen = new Set<string>();
  const options: ChatThinkingSelectOption[] = [];

  const addOption = (value: string, label?: string) => {
    const resolvedLabel =
      label ??
      value
        .split(/[-_]/g)
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
        .join(" ");
    pushUniqueTrimmedSelectOption(options, seen, value, () => resolvedLabel);
  };

  for (const level of levels) {
    const normalized = normalizeThinkLevel(level.id) ?? normalizeLowercaseStringOrEmpty(level.id);
    addOption(normalized, level.label);
  }
  if (currentOverride) {
    addOption(currentOverride);
  }
  return options;
}

function resolveThinkingLevelOptions(
  activeRow: SessionsListResult["sessions"][number] | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  provider: string | null,
  model: string | null,
): GatewayThinkingLevelOption[] {
  if (activeRow?.thinkingLevels?.length) {
    return activeRow.thinkingLevels;
  }
  const sessionModelMatchesDefaults =
    (!activeRow?.modelProvider || activeRow.modelProvider === defaults?.modelProvider) &&
    (!activeRow?.model || activeRow.model === defaults?.model);
  if (sessionModelMatchesDefaults && defaults?.thinkingLevels?.length) {
    return defaults.thinkingLevels;
  }
  const labels =
    (activeRow?.thinkingOptions?.length ? activeRow.thinkingOptions : null) ??
    (sessionModelMatchesDefaults && defaults?.thinkingOptions?.length
      ? defaults.thinkingOptions
      : null) ??
    (provider && model ? listThinkingLevelLabels(provider, model) : listThinkingLevelLabels());
  return labels.map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

function resolveChatThinkingSelectState(state: AppViewState): ChatThinkingSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const persisted = activeRow?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const { provider, model } = resolveThinkingTargetModel(state);
  const levels = resolveThinkingLevelOptions(
    activeRow,
    state.sessionsResult?.defaults,
    provider,
    model,
  );
  const defaultLevel =
    activeRow?.thinkingDefault ??
    state.sessionsResult?.defaults?.thinkingDefault ??
    (provider && model
      ? resolveThinkingDefaultForModel({
          provider,
          model,
          catalog: state.chatModelCatalog ?? [],
        })
      : "off");
  return {
    currentOverride,
    defaultLabel: `Default (${defaultLevel})`,
    options: buildThinkingOptions(levels, currentOverride),
  };
}

export function renderChatThinkingSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatThinkingSelectState(state);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled = !state.connected || busy || !state.client;
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  const onChange = async (e: Event) => {
    const next = (e.target as HTMLSelectElement).value.trim();
    await switchChatThinkingLevel(state, next);
  };
  return html`
    <label class="field chat-controls__session chat-controls__thinking-select">
      <select
        class="chat-controls__thinking-select-full"
        data-chat-thinking-select="true"
        aria-label="Chat thinking level"
        title=${selectedLabel}
        ?disabled=${disabled}
        @change=${onChange}
      >
        <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
        ${repeat(
          options,
          (entry) => entry.value,
          (entry) =>
            html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

async function switchChatModel(state: AppViewState, nextModel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const currentOverride = resolveChatModelOverrideValue(state);
  if (currentOverride === nextModel) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const prevOverride = state.chatModelOverrides[targetSessionKey];
  state.lastError = null;
  // Write the override cache immediately so the picker stays in sync during the RPC round-trip.
  state.chatModelOverrides = {
    ...state.chatModelOverrides,
    [targetSessionKey]: createChatModelOverride(nextModel),
  };
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      model: nextModel || null,
    });
    void refreshVisibleToolsEffectiveForCurrentSessionLazy(state);
    await refreshSessionOptions(state);
  } catch (err) {
    // Roll back so the picker reflects the actual server model.
    state.chatModelOverrides = { ...state.chatModelOverrides, [targetSessionKey]: prevOverride };
    state.lastError = `Failed to set model: ${String(err)}`;
  }
}

function patchSessionThinkingLevel(
  state: AppViewState,
  sessionKey: string,
  thinkingLevel: string | undefined,
) {
  const current = state.sessionsResult;
  if (!current) {
    return;
  }
  state.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey ? Object.assign({}, row, { thinkingLevel }) : row,
    ),
  };
}

async function switchChatThinkingLevel(state: AppViewState, nextThinkingLevel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return;
  }
  state.lastError = null;
  patchSessionThinkingLevel(state, targetSessionKey, normalizedNext);
  state.chatThinkingLevel = normalizedNext ?? null;
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      thinkingLevel: normalizedNext ?? null,
    });
    await refreshSessionOptions(state);
  } catch (err) {
    patchSessionThinkingLevel(state, targetSessionKey, previousThinkingLevel);
    state.chatThinkingLevel = normalizedPrev ?? null;
    state.lastError = `Failed to set thinking level: ${String(err)}`;
  }
}

/* Channel display labels. */
const CHANNEL_LABELS: Record<string, string> = {
  bluebubbles: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/** Parsed type / context extracted from a session key. */
export type SessionKeyInfo = {
  /** Prefix for typed sessions (Subagent:/Cron:). Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a session key to extract type information and a human-readable
 * fallback display name. Exported for testing.
 */
export function parseSessionKey(key: string): SessionKeyInfo {
  const normalized = normalizeLowercaseStringOrEmpty(key);

  // Main session.
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Main Session" };
  }

  // Subagent.
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }

  // Cron job.
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "Cron Job:" };
  }

  // Direct chat: agent:<x>:<channel>:direct:<id>.
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const identifier = directMatch[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }

  // Group chat: agent:<x>:<channel>:group:<id>.
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // Channel-prefixed legacy keys, for example "bluebubbles:g-...".
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }

  // Unknown: return key as-is.
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(
  key: string,
  row?: SessionsListResult["sessions"][number],
): string {
  const label = normalizeOptionalString(row?.label) ?? "";
  const displayName = normalizeOptionalString(row?.displayName) ?? "";
  const { prefix, fallbackName } = parseSessionKey(key);

  const applyTypedPrefix = (name: string): string => {
    if (!prefix) {
      return name;
    }
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*`, "i");
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  if (label && label !== key) {
    return applyTypedPrefix(label);
  }
  if (displayName && displayName !== key) {
    return applyTypedPrefix(displayName);
  }
  return fallbackName;
}

export function isCronSessionKey(key: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(key);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return true;
  }
  if (!normalized.startsWith("agent:")) {
    return false;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  const rest = parts.slice(2).join(":");
  return rest.startsWith("cron:");
}

type SessionOptionEntry = {
  key: string;
  label: string;
  scopeLabel: string;
  title: string;
};

export type SessionOptionGroup = {
  id: string;
  label: string;
  options: SessionOptionEntry[];
};

type ChatAgentFilterOption = {
  id: string;
  label: string;
};

function resolveChatAgentFilterId(state: AppViewState, sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? state.agentsList?.defaultId ?? "main");
}

function isSessionKeyTiedToAgent(key: string, agentId: string, defaultAgentId: string): boolean {
  const parsed = parseAgentSessionKey(key);
  if (parsed) {
    return normalizeAgentId(parsed.agentId) === agentId;
  }
  return agentId === defaultAgentId;
}

function isAgentMainSessionKey(key: string): boolean {
  return parseAgentSessionKey(key)?.rest === "main";
}

function resolvePreferredSessionForAgent(state: AppViewState, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const currentParsed = parseAgentSessionKey(state.sessionKey);
  if (normalizeAgentId(currentParsed?.agentId ?? defaultAgentId) === normalizedAgentId) {
    return state.sessionKey;
  }
  const rows = state.sessionsResult?.sessions ?? [];
  const row = rows
    .filter((entry) => isSessionKeyTiedToAgent(entry.key, normalizedAgentId, defaultAgentId))
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  return row?.key ?? buildAgentMainSessionKey({ agentId: normalizedAgentId });
}

function resolveChatAgentFilterOptions(state: AppViewState): ChatAgentFilterOption[] {
  const seen = new Set<string>();
  const options: ChatAgentFilterOption[] = [];
  const add = (agentId: string) => {
    const normalized = normalizeAgentId(agentId);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    options.push({
      id: normalized,
      label: resolveAgentGroupLabel(state, normalized),
    });
  };

  add(resolveChatAgentFilterId(state, state.sessionKey));
  add(state.agentsList?.defaultId ?? "main");
  for (const agent of state.agentsList?.agents ?? []) {
    add(agent.id);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    const parsed = parseAgentSessionKey(row.key);
    if (parsed) {
      add(parsed.agentId);
    }
  }

  return options;
}

export function resolveSessionOptionGroups(
  state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null,
): SessionOptionGroup[] {
  const rows = sessions?.sessions ?? [];
  const hideCron = state.sessionsHideCron ?? true;
  const activeAgentId = resolveChatAgentFilterId(state, sessionKey);
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of rows) {
    byKey.set(row.key, row);
  }

  const seenKeys = new Set<string>();
  const groups = new Map<string, SessionOptionGroup>();
  const ensureGroup = (groupId: string, label: string): SessionOptionGroup => {
    const existing = groups.get(groupId);
    if (existing) {
      return existing;
    }
    const created: SessionOptionGroup = {
      id: groupId,
      label,
      options: [],
    };
    groups.set(groupId, created);
    return created;
  };

  const addOption = (key: string) => {
    if (!key || seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    const row = byKey.get(key);
    const parsed = parseAgentSessionKey(key);
    const group = parsed
      ? ensureGroup(
          `agent:${normalizeLowercaseStringOrEmpty(parsed.agentId)}`,
          resolveAgentGroupLabel(state, parsed.agentId),
        )
      : ensureGroup("other", "Other Sessions");
    const scopeLabel = normalizeOptionalString(parsed?.rest) ?? key;
    const label = resolveSessionScopedOptionLabel(key, row, parsed?.rest);
    group.options.push({
      key,
      label,
      scopeLabel,
      title: key,
    });
  };

  for (const row of rows) {
    if (
      !isSessionKeyTiedToAgent(row.key, activeAgentId, defaultAgentId) &&
      row.key !== sessionKey
    ) {
      continue;
    }
    if (row.key !== sessionKey && (row.kind === "global" || row.kind === "unknown")) {
      continue;
    }
    if (hideCron && row.key !== sessionKey && isCronSessionKey(row.key)) {
      continue;
    }
    addOption(row.key);
  }
  if (byKey.has(sessionKey)) {
    addOption(sessionKey);
  } else if (isAgentMainSessionKey(sessionKey)) {
    addOption(sessionKey);
  }

  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const option of group.options) {
      counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    }
    for (const option of group.options) {
      if ((counts.get(option.label) ?? 0) > 1 && option.scopeLabel !== option.label) {
        option.label = `${option.label} · ${option.scopeLabel}`;
      }
    }
  }

  const allOptions = Array.from(groups.values()).flatMap((group) =>
    group.options.map((option) => ({ groupLabel: group.label, option })),
  );
  const labels = new Map(allOptions.map(({ option }) => [option, option.label]));
  const countAssignedLabels = () => {
    const counts = new Map<string, number>();
    for (const { option } of allOptions) {
      const label = labels.get(option) ?? option.label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  };
  const labelIncludesScopeLabel = (label: string, scopeLabel: string) => {
    const trimmedScope = scopeLabel.trim();
    if (!trimmedScope) {
      return false;
    }
    return (
      label === trimmedScope ||
      label.endsWith(` · ${trimmedScope}`) ||
      label.endsWith(` / ${trimmedScope}`)
    );
  };

  const globalCounts = countAssignedLabels();
  for (const { groupLabel, option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((globalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    const scopedPrefix = `${groupLabel} / `;
    if (currentLabel.startsWith(scopedPrefix)) {
      continue;
    }
    // Keep the agent visible once the native select collapses to a single chosen label.
    labels.set(option, `${groupLabel} / ${currentLabel}`);
  }

  const scopedCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((scopedCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    if (labelIncludesScopeLabel(currentLabel, option.scopeLabel)) {
      continue;
    }
    labels.set(option, `${currentLabel} · ${option.scopeLabel}`);
  }

  const finalCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((finalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    // Fall back to the full key only when every friendlier disambiguator still collides.
    labels.set(option, `${currentLabel} · ${option.key}`);
  }

  for (const { option } of allOptions) {
    option.label = labels.get(option) ?? option.label;
  }

  return Array.from(groups.values());
}

function resolveAgentGroupLabel(state: AppViewState, agentIdRaw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(agentIdRaw);
  const agent = (state.agentsList?.agents ?? []).find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === normalized,
  );
  const name =
    normalizeOptionalString(agent?.identity?.name) ?? normalizeOptionalString(agent?.name) ?? "";
  return name && name !== agentIdRaw ? `${name} (${agentIdRaw})` : agentIdRaw;
}

function resolveSessionScopedOptionLabel(
  key: string,
  row?: SessionsListResult["sessions"][number],
  rest?: string,
) {
  const base = normalizeOptionalString(rest) ?? key;
  if (!row) {
    return base;
  }

  const label = normalizeOptionalString(row.label) ?? "";
  const displayName = normalizeOptionalString(row.displayName) ?? "";
  if ((label && label !== key) || (displayName && displayName !== key)) {
    return resolveSessionDisplayName(key, row);
  }

  return base;
}
