// Config-tranche migrations move legacy aliases before canonical validation.
import { ensureRecord, getRecord } from "../../../config/legacy.shared.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/account-id.js";

function deletePath(owner: unknown, path: readonly string[], index = 0): boolean {
  const record = getRecord(owner);
  const key = path[index];
  if (!record || !key) {
    return false;
  }
  if (index === path.length - 1) {
    if (!Object.hasOwn(record, key)) {
      return false;
    }
    delete record[key];
    return true;
  }
  const child = getRecord(record[key]);
  if (!child || !deletePath(child, path, index + 1)) {
    return false;
  }
  if (Object.keys(child).length === 0) {
    delete record[key];
  }
  return true;
}

function visitAgentEntries(
  raw: Record<string, unknown>,
  visitor: (entry: Record<string, unknown>, path: string) => void,
): void {
  const agents = getRecord(raw.agents);
  const entries = getRecord(agents?.entries);
  if (entries) {
    for (const [agentId, value] of Object.entries(entries)) {
      const entry = getRecord(value);
      if (entry) {
        visitor(entry, `agents.entries.${agentId}`);
      }
    }
  }
  if (Array.isArray(agents?.list)) {
    agents.list.forEach((value, index) => {
      const entry = getRecord(value);
      if (entry) {
        visitor(entry, `agents.list[${index}]`);
      }
    });
  }
}

function stripRetiredPresentationPrefs(raw: Record<string, unknown>, changes: string[]): void {
  const prefs = getRecord(getRecord(raw.ui)?.prefs);
  if (!prefs) {
    return;
  }
  const removed = ["chatMessageMaxWidth", "textScale", "sidebarLiveActivity"].filter((key) => {
    if (!Object.hasOwn(prefs, key)) {
      return false;
    }
    delete prefs[key];
    return true;
  });
  if (removed.length > 0) {
    changes.push(
      `Removed browser-local ui.prefs keys: ${removed.map((key) => `ui.prefs.${key}`).join(", ")}.`,
    );
  }
  const ui = getRecord(raw.ui);
  if (Object.keys(prefs).length === 0) {
    delete ui?.prefs;
  }
  if (ui && Object.keys(ui).length === 0) {
    delete raw.ui;
  }
}

function stripRetiredAgentConfig(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  let removedContextLimits = false;
  const stripContextLimits = (owner: Record<string, unknown>) => {
    for (const key of ["memoryGetDefaultLines", "toolResultMaxChars"]) {
      removedContextLimits = deletePath(owner, ["contextLimits", key]) || removedContextLimits;
    }
  };
  if (defaults) {
    stripContextLimits(defaults);
  }
  let removedTypingOverride = false;
  visitAgentEntries(raw, (entry) => {
    if (Object.hasOwn(entry, "typingIntervalSeconds")) {
      delete entry.typingIntervalSeconds;
      removedTypingOverride = true;
    }
    stripContextLimits(entry);
  });
  if (removedTypingOverride) {
    changes.push(
      "Removed per-agent typingIntervalSeconds overrides; agents.defaults.typingIntervalSeconds now applies to every agent.",
    );
  }
  if (removedContextLimits) {
    changes.push(
      "Removed contextLimits.memoryGetDefaultLines/toolResultMaxChars overrides; canonical memory and context-window caps now apply.",
    );
  }
}

type LegacyWhatsAppDebounce = { path: string; value?: number; accountId?: string };
type LegacyWhatsAppDebounceWithValue = LegacyWhatsAppDebounce & { value: number };

function readLegacyDebounce(
  path: string,
  owner: Record<string, unknown>,
  accountId?: string,
): LegacyWhatsAppDebounce | null {
  if (!Object.hasOwn(owner, "debounceMs")) {
    return null;
  }
  const raw = owner.debounceMs;
  delete owner.debounceMs;
  return {
    path,
    ...(accountId ? { accountId } : {}),
    ...(typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? { value: raw } : {}),
  };
}

function migrateWhatsAppDebounce(raw: Record<string, unknown>, changes: string[]): void {
  const whatsapp = getRecord(getRecord(raw.channels)?.whatsapp);
  if (!whatsapp) {
    return;
  }
  const sources: LegacyWhatsAppDebounce[] = [];
  const rootSource = readLegacyDebounce("channels.whatsapp.debounceMs", whatsapp);
  if (rootSource) {
    sources.push(rootSource);
  }
  const accounts = getRecord(whatsapp.accounts);
  if (accounts) {
    for (const accountId of Object.keys(accounts).toSorted()) {
      const account = getRecord(accounts[accountId]);
      if (!account) {
        continue;
      }
      const source = readLegacyDebounce(
        `channels.whatsapp.accounts.${accountId}.debounceMs`,
        account,
        normalizeAccountId(accountId),
      );
      if (source) {
        sources.push(source);
      }
    }
  }
  if (sources.length === 0) {
    return;
  }

  const validSources = sources.filter(
    (source): source is LegacyWhatsAppDebounceWithValue => source.value !== undefined,
  );
  if (validSources.length === 0) {
    changes.push(
      `Removed invalid WhatsApp debounce values: ${sources.map((source) => source.path).join(", ")}.`,
    );
    return;
  }

  const inbound = ensureRecord(ensureRecord(raw, "messages"), "inbound");
  const byChannel = ensureRecord(inbound, "byChannel");
  if (byChannel.whatsapp !== undefined) {
    changes.push(
      `Removed ${sources.map((source) => source.path).join(", ")} (messages.inbound.byChannel.whatsapp already set).`,
    );
    return;
  }

  const configuredDefaultAccount = normalizeAccountId(
    typeof whatsapp.defaultAccount === "string" ? whatsapp.defaultAccount : undefined,
  );
  const selected =
    validSources.find((source) => source.accountId === configuredDefaultAccount) ??
    validSources.find((source) => source.accountId === DEFAULT_ACCOUNT_ID) ??
    validSources.find((source) => source.path === "channels.whatsapp.debounceMs") ??
    validSources[0];
  if (!selected) {
    return;
  }
  byChannel.whatsapp = selected.value;
  const distinctValues = new Set(validSources.map((source) => source.value));
  if (distinctValues.size === 1 && validSources.length === sources.length) {
    changes.push(
      `Moved ${sources.map((source) => source.path).join(", ")} → messages.inbound.byChannel.whatsapp.`,
    );
  } else {
    changes.push(
      `Collapsed conflicting WhatsApp debounce values into messages.inbound.byChannel.whatsapp using ${selected.path} (${selected.value} ms); account-specific debounce is no longer supported.`,
    );
  }
}

export function migrateConfigTranche(raw: Record<string, unknown>, changes: string[]): void {
  stripRetiredPresentationPrefs(raw, changes);
  if (deletePath(raw, ["skills", "load", "watchDebounceMs"])) {
    changes.push("Removed skills.load.watchDebounceMs; the watcher now uses the 250 ms default.");
  }
  stripRetiredAgentConfig(raw, changes);
  migrateWhatsAppDebounce(raw, changes);
}

export function hasConfigTrancheLegacyKeys(root: Record<string, unknown>): boolean {
  const changes: string[] = [];
  migrateConfigTranche(structuredClone(root), changes);
  return changes.length > 0;
}
