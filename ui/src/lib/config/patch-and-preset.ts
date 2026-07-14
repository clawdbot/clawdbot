/**
 * Config preset application — patching and post-patch reconciliation helpers.
 * Extracted from config/index.ts to offset LOC growth in an already-oversized module.
 */

import { cloneConfigObject, serializeConfigForm } from "../config-form-utils.ts";

// ── Minimal duck-typed interfaces avoiding circular imports from index.ts ──

interface PatchState {
  client: { request<T = unknown>(method: string, params?: unknown): Promise<T> } | null;
  connected: boolean;
  applySessionKey: string;
  configSnapshot: { hash?: string | null } | null;
  lastError: string | null;
  chatError?: string | null;
}

interface PatchOptions {
  raw: string | Record<string, unknown>;
  note: string;
  replacePaths?: string[];
}

interface PresetState extends PatchState {
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configRaw: string;
  configRawOriginal: string;
  configFormMode: "form" | "raw";
  configDraftBaseHash?: string | null;
  // loadConfig touches these fields — included so ConfigState satisfies PresetState
  configLoading: boolean;
  configFormDirty: boolean;
}

type ConnectionGuard = {
  /** Returns the current connection epoch for the state object. */
  epoch: (state: object) => number;
  /** Returns true when the state still references the given client with the expected epoch. */
  isCurrent: (state: object, client: { request: CallableFunction }, epoch: number) => boolean;
};

type LoadConfigFn = (
  state: PresetState,
  options: { discardPendingChanges?: boolean },
) => Promise<void>;
type ResolveSnapshotFn = (
  snapshot: { hash?: string | null } | null,
) => Record<string, unknown> | null;

// ── patchConfig ──

export async function patchConfig(
  state: PatchState,
  options: PatchOptions,
  guard: ConnectionGuard,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = guard.epoch(state);
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    state.lastError = "Config hash missing; refresh and retry.";
    return false;
  }
  state.lastError = null;
  state.chatError = null;
  try {
    await client.request("config.patch", {
      baseHash,
      raw: typeof options.raw === "string" ? options.raw : JSON.stringify(options.raw),
      sessionKey: state.applySessionKey,
      note: options.note,
      ...(options.replacePaths?.length ? { replacePaths: options.replacePaths } : {}),
    });
    return guard.isCurrent(state, client as { request: CallableFunction }, connectionEpoch);
  } catch (err) {
    if (guard.isCurrent(state, client as { request: CallableFunction }, connectionEpoch)) {
      state.lastError = String(err);
    }
    return false;
  }
}

// ── applyPresetConfig ──

export async function applyPresetConfig(
  state: PresetState,
  patch: Record<string, unknown>,
  note: string,
  guard: ConnectionGuard,
  loadConfig: LoadConfigFn,
  resolveSnapshot: ResolveSnapshotFn,
): Promise<boolean> {
  const ok = await patchConfig(state, { raw: patch, note }, guard);
  if (!ok) {
    return false;
  }
  // Reload config from the server, preserving any unrelated staged edits the
  // user has in the form (e.g., a Quick Settings field changed before
  // clicking a Context Profile preset).
  await loadConfig(state, { discardPendingChanges: false });
  // Advance the draft base hash to the post-patch snapshot so the next staged
  // Save or Apply uses the current server hash as its base.
  state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  // Fold the just-applied preset values into the active form so they survive
  // the next save instead of being reverted by old form values that were
  // preserved across the reload.
  if (state.configForm) {
    mergePresetIntoForm(state.configForm, patch);
    // Rebase clean baselines to the post-preset server snapshot so Reset,
    // dirty detection, and subsequent saves use the patched state.
    const snapshotConfig = resolveSnapshot(state.configSnapshot);
    if (snapshotConfig) {
      state.configFormOriginal = cloneConfigObject(snapshotConfig);
      state.configRawOriginal = serializeConfigForm(snapshotConfig);
    }
    if (state.configFormMode !== "raw") {
      state.configRaw = serializeConfigForm(state.configForm);
    } else {
      // Reconcile dirty raw JSON: merge preset into raw document so
      // subsequent raw-mode saves don't silently overwrite the preset.
      try {
        const rawObj = JSON.parse(state.configRaw);
        mergePresetIntoForm(rawObj as Record<string, unknown>, patch);
        state.configRaw = JSON.stringify(rawObj, null, 2);
      } catch {
        // Invalid JSON — leave unchanged; form editor surfaces parse errors
      }
    }
  }
  return true;
}

// ── mergePresetIntoForm ──

export function mergePresetIntoForm(
  form: Record<string, unknown>,
  preset: Record<string, unknown>,
): void {
  for (const key of Object.keys(preset)) {
    const presetVal = preset[key];
    const formVal = form[key];
    if (
      presetVal !== null &&
      typeof presetVal === "object" &&
      !Array.isArray(presetVal) &&
      formVal !== null &&
      typeof formVal === "object" &&
      !Array.isArray(formVal)
    ) {
      mergePresetIntoForm(formVal as Record<string, unknown>, presetVal as Record<string, unknown>);
    } else {
      form[key] = presetVal;
    }
  }
}
