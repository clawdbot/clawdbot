// Types for the extension's pure-logic module (the runtime is plain ESM JS so
// it can load unbundled in Chrome). Kept in sync with relay-core.js.

export const OPENCLAW_TAB_GROUP_TITLE: string;
export const EXTENSION_RELAY_PROTOCOL: string;

export function parsePairingString(raw: unknown): { relayUrl: string; token: string } | null;

export function buildRelayWsProtocols(token: string): string[];

export function reconnectDelayMs(attempt: number): number;

export function nearestGroupColor(hex: unknown): string;

export function toRelayTabInfo(tab: {
  id: number;
  url?: string;
  title?: string;
  active?: boolean;
}): { tabId: number; url: string; title: string; active: boolean };
