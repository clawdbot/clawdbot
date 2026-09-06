import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserTabOwnership } from "./client.types.js";
import { clearVolatileTabAliases } from "./session-tab-ephemeral-aliases.js";
import { browserSessionTabRouteKey, type BrowserSessionTabRoute } from "./session-tab-route.js";

export type SessionTabInteractionIdentity = {
  sessionKey: string;
  targetId: string;
  route: BrowserSessionTabRoute;
  profile?: string;
};

export type VolatileSessionTab = SessionTabInteractionIdentity & {
  kind: "volatile";
  // Activity preserves this identity; registration replaces it even within one clock tick.
  registration: object;
  ownership?: BrowserTabOwnership;
  trackedAt: number;
  lastUsedAt: number;
};

export function normalizeBrowserSessionKey(value: string | undefined): string | undefined {
  return normalizeOptionalLowercaseString(value);
}

export function volatileSessionTabTargetKey(
  identity: Pick<SessionTabInteractionIdentity, "targetId" | "route" | "profile">,
): string {
  return `${identity.targetId}\u0000${browserSessionTabRouteKey(identity.route)}\u0000${identity.profile ?? ""}`;
}

export function sameVolatileSessionTab(
  left: VolatileSessionTab,
  right: VolatileSessionTab,
): boolean {
  return (
    volatileSessionTabTargetKey(left) === volatileSessionTabTargetKey(right) &&
    left.sessionKey === right.sessionKey &&
    left.trackedAt === right.trackedAt &&
    left.lastUsedAt === right.lastUsedAt
  );
}

const volatileStateSymbol = Symbol.for("openclaw.browser.session-tabs.volatile");
const volatileCleanupStateSymbol = Symbol.for("openclaw.browser.session-tabs.volatile-cleanup");
const activeDurableStateSymbol = Symbol.for("openclaw.browser.session-tabs.active-durable-keys");
const coldNativeActivityStateSymbol = Symbol.for(
  "openclaw.browser.session-tabs.cold-native-activity",
);

export function activeDurableStorageKeys(): Set<string> {
  const state = globalThis as typeof globalThis & {
    [activeDurableStateSymbol]?: Set<string>;
  };
  state[activeDurableStateSymbol] ??= new Set();
  return state[activeDurableStateSymbol];
}

export function volatileTabsBySession(): Map<string, Map<string, VolatileSessionTab>> {
  const state = globalThis as typeof globalThis & {
    [volatileStateSymbol]?: Map<string, Map<string, VolatileSessionTab>>;
  };
  state[volatileStateSymbol] ??= new Map();
  return state[volatileStateSymbol];
}

type VolatileTabCleanup = {
  registrations: VolatileSessionTab[];
  promise: Promise<number>;
};

/** Keeps one in-flight volatile target close shared across Browser plugin bundles. */
export function volatileTabCleanupByTarget(): Map<string, VolatileTabCleanup> {
  const state = globalThis as typeof globalThis & {
    [volatileCleanupStateSymbol]?: Map<string, VolatileTabCleanup>;
  };
  state[volatileCleanupStateSymbol] ??= new Map();
  return state[volatileCleanupStateSymbol];
}

export function volatileRegistrationsForTarget(targetKey: string): VolatileSessionTab[] {
  const result: VolatileSessionTab[] = [];
  for (const tabs of volatileTabsBySession().values()) {
    for (const tab of tabs.values()) {
      if (volatileSessionTabTargetKey(tab) === targetKey) {
        result.push(tab);
      }
    }
  }
  return result;
}

export function deleteVolatileRegistrations(tabs: VolatileSessionTab[]): void {
  for (const tab of tabs) {
    const targetKey = volatileSessionTabTargetKey(tab);
    const current = volatileTabsBySession().get(tab.sessionKey)?.get(targetKey);
    if (current?.registration === tab.registration) {
      deleteVolatileSessionTab(tab.sessionKey, targetKey);
    }
  }
}

export function deleteVolatileSessionTab(sessionKey: string, tabKey: string): void {
  const state = volatileTabsBySession();
  const tabs = state.get(sessionKey);
  tabs?.delete(tabKey);
  clearVolatileTabAliases(sessionKey, tabKey);
  if (tabs?.size === 0) {
    state.delete(sessionKey);
  }
}

function coldNativeActivity(): Map<string, number> {
  const state = globalThis as typeof globalThis & {
    [coldNativeActivityStateSymbol]?: Map<string, number>;
  };
  state[coldNativeActivityStateSymbol] ??= new Map();
  return state[coldNativeActivityStateSymbol];
}

export function rememberColdNativeActivity(identity: string, now: number): void {
  coldNativeActivity().set(identity, now);
}

export function forgetColdNativeActivity(identity: string): void {
  coldNativeActivity().delete(identity);
}

export function readColdNativeActivity(identity: string): number | undefined {
  return coldNativeActivity().get(identity);
}
