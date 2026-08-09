/**
 * Target id resolution helpers for Browser tab aliases and user-facing ids.
 */
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";

const TAB_LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Validate and normalize a user-facing tab label before browser mutation. */
export function normalizeTabLabel(label: string): string {
  const trimmed = label.trim();
  if (!TAB_LABEL_PATTERN.test(trimmed)) {
    throw new Error("tab label must be 1-64 chars and use only letters, numbers, _, ., :, or -");
  }
  return trimmed;
}

function getTabAliasState(
  profileState: ProfileRuntimeState,
): NonNullable<ProfileRuntimeState["tabAliases"]> {
  profileState.tabAliases ??= { nextTabNumber: 1, byTargetId: {} };
  return profileState.tabAliases;
}

/** Assign a stable friendly id and optional validated label to one tab. */
export function assignTabAlias(params: {
  profileState: ProfileRuntimeState;
  tab: BrowserTab;
  label?: string;
}): BrowserTab {
  const label = params.label === undefined ? undefined : normalizeTabLabel(params.label);
  const aliases = getTabAliasState(params.profileState);
  let entry = aliases.byTargetId[params.tab.targetId];
  if (!entry) {
    entry = { tabId: `t${aliases.nextTabNumber}` };
    aliases.nextTabNumber += 1;
    aliases.byTargetId[params.tab.targetId] = entry;
  }
  if (label) {
    for (const [targetId, current] of Object.entries(aliases.byTargetId)) {
      if (targetId !== params.tab.targetId && current.label === label) {
        delete current.label;
      }
    }
    entry.label = label;
  }
  entry.url = params.tab.url;
  const labelFields = entry.label ? { label: entry.label } : {};
  return {
    ...params.tab,
    suggestedTargetId: entry.label ?? entry.tabId,
    tabId: entry.tabId,
    ...labelFields,
  };
}

type TabAliasEntry = NonNullable<ProfileRuntimeState["tabAliases"]>["byTargetId"][string];

function normalizeReplacementUrl(url: string | undefined): string | undefined {
  return url?.trim() || undefined;
}

function findConfidentReplacement(params: {
  staleEntry: TabAliasEntry;
  staleEntries: Array<[targetId: string, entry: TabAliasEntry]>;
  newCandidates: BrowserTab[];
}): BrowserTab | undefined {
  const { staleEntry, staleEntries, newCandidates } = params;
  // Preserve shipped form-submit continuity when the replacement set is one-for-one.
  if (staleEntries.length === 1 && newCandidates.length === 1) {
    return newCandidates[0];
  }

  const url = normalizeReplacementUrl(staleEntry.url);
  if (!url) {
    return undefined;
  }
  const staleMatches = staleEntries.filter(
    ([, entry]) => normalizeReplacementUrl(entry.url) === url,
  );
  const candidates = newCandidates.filter((tab) => normalizeReplacementUrl(tab.url) === url);
  // Duplicate URL buckets have no ordering contract, so only migrate an exact 1:1 bucket.
  return staleMatches.length === 1 && candidates.length === 1 ? candidates[0] : undefined;
}

/** Reconcile stable aliases with the latest authoritative browser tab list. */
export function assignTabAliases(
  profileState: ProfileRuntimeState,
  tabs: BrowserTab[],
  migrateReplacements: boolean,
): BrowserTab[] {
  const aliases = getTabAliasState(profileState);
  const liveTargetIds = new Set(tabs.map((tab) => tab.targetId));
  const staleEntries = Object.entries(aliases.byTargetId).filter(
    ([targetId]) => !liveTargetIds.has(targetId),
  );
  const newCandidates = tabs.filter((tab) => !aliases.byTargetId[tab.targetId]);
  if (migrateReplacements) {
    for (const [oldTargetId, staleEntry] of staleEntries) {
      const candidate = findConfidentReplacement({ staleEntry, staleEntries, newCandidates });
      if (!candidate) {
        continue;
      }
      aliases.byTargetId[candidate.targetId] = staleEntry;
      delete aliases.byTargetId[oldTargetId];
      if (profileState.lastTargetId === oldTargetId) {
        profileState.lastTargetId = candidate.targetId;
      }
    }
  }

  for (const targetId of Object.keys(aliases.byTargetId)) {
    if (!liveTargetIds.has(targetId)) {
      delete aliases.byTargetId[targetId];
    }
  }
  return tabs.map((tab) => assignTabAlias({ profileState, tab }));
}

/** Result for resolving a user-supplied tab id, label, or target prefix. */
type TargetIdResolution =
  | { ok: true; targetId: string }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: string[] };

/** Resolves exact tab references first, then unique raw target-id prefixes. */
export function resolveTargetIdFromTabs(
  input: string,
  tabs: Array<{ targetId: string; suggestedTargetId?: string; tabId?: string; label?: string }>,
): TargetIdResolution {
  const needle = input.trim();
  if (!needle) {
    return { ok: false, reason: "not_found" };
  }

  // Friendly references and raw CDP ids share one input field, so a cross-namespace
  // collision must fail closed instead of silently choosing a different tab.
  const exactMatches = [
    ...new Set(
      tabs
        .filter(
          (tab) =>
            tab.targetId === needle ||
            tab.suggestedTargetId === needle ||
            tab.tabId === needle ||
            tab.label === needle,
        )
        .map((tab) => tab.targetId),
    ),
  ];
  const onlyExact = exactMatches[0];
  if (exactMatches.length === 1 && onlyExact !== undefined) {
    return { ok: true, targetId: onlyExact };
  }
  if (exactMatches.length > 1) {
    return { ok: false, reason: "ambiguous", matches: exactMatches };
  }

  const lower = normalizeLowercaseStringOrEmpty(needle);
  const matches = tabs
    .map((t) => t.targetId)
    .filter((id) => normalizeLowercaseStringOrEmpty(id).startsWith(lower));

  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) {
    return { ok: true, targetId: only };
  }
  if (matches.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: "ambiguous", matches };
}
