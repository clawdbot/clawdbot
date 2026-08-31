import {
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import type {
  UsersPrefsGetResult,
  UsersPrefsSetResult,
} from "../../../packages/gateway-protocol/src/schema/users.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { isAppearancePref, type ServerUiPrefs } from "./server-prefs-state.ts";

type ProfileAppearancePrefs = { profileId: string; scope: string; prefs: ServerUiPrefs };

let profileAppearancePrefs: ProfileAppearancePrefs | null = null;
let profilePreferencesRequestId = 0;

export function resolveProfilePreferenceScope(scope: string, profileId?: string | null): string {
  return profileId ? `${scope}:profile:${profileId}` : scope;
}

export function resolveProfileAppearancePrefs(
  scope: string,
  profileId?: string | null,
): ServerUiPrefs | null {
  return profileId &&
    profileAppearancePrefs?.profileId === profileId &&
    profileAppearancePrefs.scope === scope
    ? profileAppearancePrefs.prefs
    : null;
}

export function resolveProfileAppearanceProfileId(scope: string): string | null {
  return profileAppearancePrefs?.scope === scope ? profileAppearancePrefs.profileId : null;
}

export function resetProfileAppearancePrefs(): void {
  profileAppearancePrefs = null;
  profilePreferencesRequestId += 1;
}

export async function loadProfileAppearancePrefs(
  client: GatewayBrowserClient,
  profileId: string,
  scope: string,
): Promise<boolean> {
  const requestId = ++profilePreferencesRequestId;
  const result = await client.request<UsersPrefsGetResult>("users.prefs.get", {
    keys: Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
  });
  if (requestId !== profilePreferencesRequestId || result.status !== "ok") {
    return false;
  }
  const prefs: ServerUiPrefs = {};
  for (const [key, preferenceKey] of Object.entries(UI_APPEARANCE_PREFERENCE_KEYS)) {
    if (!isAppearancePref(key)) {
      continue;
    }
    const value = normalizeUiAppearancePreference(preferenceKey, result.entries[preferenceKey]);
    if (value !== undefined) {
      Object.assign(prefs, { [key]: value });
    }
  }
  profileAppearancePrefs = { profileId, scope, prefs };
  return true;
}

export async function writeProfileAppearancePrefs(
  client: GatewayBrowserClient | null,
  batch: ServerUiPrefs,
  canDispatch: boolean,
): Promise<Awaited<ReturnType<RuntimeConfigCapability["runExternalMutation"]>>> {
  if (!client || !canDispatch) {
    return { ok: false, reason: "unavailable", error: "Profile preferences are unavailable." };
  }
  const entries = Object.fromEntries(
    Object.entries(batch).flatMap(([key, value]) =>
      isAppearancePref(key) ? [[UI_APPEARANCE_PREFERENCE_KEYS[key], value]] : [],
    ),
  );
  try {
    const result = await client.request<UsersPrefsSetResult>("users.prefs.set", { entries });
    return result.status === "ok"
      ? { ok: true, value: result, refresh: { ok: true } }
      : { ok: false, reason: "rejected", error: "Profile preferences are unavailable." };
  } catch (error) {
    const rejected =
      error instanceof GatewayRequestError &&
      (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN");
    return {
      ok: false,
      reason: rejected ? "rejected" : "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
