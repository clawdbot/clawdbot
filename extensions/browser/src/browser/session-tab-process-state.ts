export type SessionTabInteractionIdentity = {
  sessionKey: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
};

export type VolatileSessionTab = SessionTabInteractionIdentity & {
  kind: "volatile";
  trackedAt: number;
  lastUsedAt: number;
};

const volatileStateSymbol = Symbol.for("openclaw.browser.session-tabs.volatile");
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
import { clearVolatileTabAliases } from "./session-tab-ephemeral-aliases.js";
