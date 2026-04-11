import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { resolveDefaultWhatsAppAccountId } from "./accounts.js";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<{ messageId: string }>;
  sendPoll: (to: string, poll: PollInput) => Promise<{ messageId: string }>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<void>;
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
};

// WhatsApp shares a live Baileys socket between inbound and outbound runtime
// chunks. Keep this on a direct globalThis symbol lookup; the generic
// singleton helper was previously inlined during code-splitting and split the
// listener state back into per-chunk Maps.
const WHATSAPP_ACTIVE_LISTENER_STATE_KEY = Symbol.for("openclaw.whatsapp.activeListenerState");

type ActiveListenerState = {
  listeners: Map<string, ActiveWebListener>;
  current: ActiveWebListener | null;
};

const g = globalThis as unknown as Record<symbol, ActiveListenerState | undefined>;
if (!g[WHATSAPP_ACTIVE_LISTENER_STATE_KEY]) {
  g[WHATSAPP_ACTIVE_LISTENER_STATE_KEY] = {
    listeners: new Map<string, ActiveWebListener>(),
    current: null,
  };
}
const state = g[WHATSAPP_ACTIVE_LISTENER_STATE_KEY];

function setCurrentListener(listener: ActiveWebListener | null): void {
  state.current = listener;
}

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || resolveDefaultWhatsAppAccountId(loadConfig());
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = state.listeners.get(id) ?? null;
  if (!listener) {
    throw new Error(
      `No active WhatsApp Web listener (account: ${id}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${id}`)}.`,
    );
  }
  return { accountId: id, listener };
}

export function setActiveWebListener(listener: ActiveWebListener | null): void;
export function setActiveWebListener(
  accountId: string | null | undefined,
  listener: ActiveWebListener | null,
): void;
export function setActiveWebListener(
  accountIdOrListener: string | ActiveWebListener | null | undefined,
  maybeListener?: ActiveWebListener | null,
): void {
  const { accountId, listener } =
    typeof accountIdOrListener === "string"
      ? { accountId: accountIdOrListener, listener: maybeListener ?? null }
      : {
          // Resolve the configured default account name so that callers using the
          // single-arg overload register under the right key (e.g. "work"), not
          // always under DEFAULT_ACCOUNT_ID ("default").
          accountId: resolveDefaultWhatsAppAccountId(loadConfig()),
          listener: accountIdOrListener ?? null,
        };

  const id = resolveWebAccountId(accountId);
  if (!listener) {
    state.listeners.delete(id);
  } else {
    state.listeners.set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    setCurrentListener(listener);
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return state.listeners.get(id) ?? null;
}
