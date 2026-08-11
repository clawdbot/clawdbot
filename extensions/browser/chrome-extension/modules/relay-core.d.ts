// Types for the extension's pure-logic module (the runtime is plain ESM JS so
// it can load unbundled in Chrome). Kept in sync with relay-core.js.

export const OPENCLAW_TAB_GROUP_TITLE: string;
export const ACCESS_MODE_ALL: "all";
export const ACCESS_MODE_SELECTED: "selected";
export function parsePairingString(raw: unknown): {
  relayUrl: string;
  token: string;
  gatewayUrl?: string;
} | null;
export function createPairingConfigStore(storage: {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}): {
  readonly invalidationRevision: number;
  read(): Promise<{
    relayUrl: string;
    token: string;
    gatewayUrl: string;
    authVersion?: 2;
    accessMode: "all" | "selected";
    groupColor: string;
    pairingStatusHint: string;
  }>;
  save(
    pairing: { relayUrl: string; token: string; gatewayUrl?: string },
    groupColor: string,
    accessMode?: "all" | "selected",
  ): Promise<void>;
  setAccessMode(accessMode: unknown): Promise<"all" | "selected">;
  clear(): Promise<void>;
};

export function buildRelayWsProtocols(): string[];

export function reconnectDelayMs(attempt: number): number;

export function nearestGroupColor(hex: unknown): string;

export function toRelayTabInfo(tab: {
  id: number;
  url?: string;
  title?: string;
  active?: boolean;
}): { tabId: number; url: string; title: string; active: boolean };
