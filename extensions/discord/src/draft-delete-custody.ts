// Discord plugin module implementing failed draft-delete custody.
//
// A draft preview whose DELETE fails repeatedly outlives the per-turn
// controller that owned it: once the controller's final cleanup sweep
// finishes, nothing in the turn lifecycle retries the delete. This registry
// keeps custody of those failed deletes per account and drains them at later
// lifecycle boundaries plus a bounded delayed retry, so previews are removed
// after transient REST failures instead of being orphaned.
// The registry state lives on a global symbol (thread-bindings pattern) so it
// survives loader re-instantiation and test support can reset it.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

/** A failed draft-preview delete awaiting a later retry. */
export type DiscordDraftDeleteCustodyEntry = {
  channelId: string;
  messageId: string;
  /** Delete the Discord message. Must throw when the delete fails. */
  remove: () => Promise<void>;
};

const RETRY_DELAY_MS = 30_000;
const MAX_CUSTODY_DELETE_ATTEMPTS = 3;
const MAX_CUSTODY_ENTRIES_PER_ACCOUNT = 50;
// Sentinel key for an empty account id. Uses a prefix that cannot collide
// with user-configured account IDs.
const DEFAULT_ACCOUNT_KEY = "\0__default__";

type CustodyRecord = {
  entry: DiscordDraftDeleteCustodyEntry;
  attempts: number;
};

type AccountCustody = {
  pending: CustodyRecord[];
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Warn sink retained from adoption so timer-driven retries keep diagnostics. */
  warn: ((message: string) => void) | undefined;
  /** Active drain promise; concurrent drains await it instead of overlapping. */
  drainInFlight: Promise<void> | undefined;
};

// The registry lives on a global symbol so test support can reset it across
// loader instances, mirroring the thread-bindings registry pattern.
const CUSTODY_STATE_KEY = Symbol.for("openclaw.discordDraftDeleteCustodyState");

type CustodyState = {
  byAccount: Map<string, AccountCustody>;
};

function getCustodyState(): CustodyState {
  // SAFETY: globalThis is indexed as a plain record to stash the registry.
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  // SAFETY: this module exclusively owns the custody state under this symbol.
  let state = globalStore[CUSTODY_STATE_KEY] as CustodyState | undefined;
  if (!state) {
    state = { byAccount: new Map() };
    globalStore[CUSTODY_STATE_KEY] = state;
  }
  return state;
}

function getCustodyByAccount(): Map<string, AccountCustody> {
  return getCustodyState().byAccount;
}

function resolveAccountKey(accountId: string): string {
  return accountId || DEFAULT_ACCOUNT_KEY;
}

function scheduleCustodyRetry(key: string, custody: AccountCustody): void {
  if (custody.retryTimer || !custody.pending.length) {
    return;
  }
  custody.retryTimer = setTimeout(() => {
    custody.retryTimer = undefined;
    void drainDiscordDraftDeleteCustodyByKey(key, custody.warn);
  }, RETRY_DELAY_MS);
  custody.retryTimer.unref?.();
}

/** Stop and clear a custody record's pending retry timer. */
function clearCustodyRetryTimer(custody: AccountCustody): void {
  if (custody.retryTimer) {
    clearTimeout(custody.retryTimer);
    custody.retryTimer = undefined;
  }
}

/** Take ownership of failed deletes so later retries can remove them. */
export function adoptDiscordDraftDeleteCustody(params: {
  accountId: string;
  messages: DiscordDraftDeleteCustodyEntry[];
  warn?: (message: string) => void;
}): void {
  if (!params.messages.length) {
    return;
  }
  const key = resolveAccountKey(params.accountId);
  const custodyByAccount = getCustodyByAccount();
  let custody = custodyByAccount.get(key);
  if (!custody) {
    custody = { pending: [], retryTimer: undefined, warn: undefined, drainInFlight: undefined };
    custodyByAccount.set(key, custody);
  }
  // Retain the latest warn sink so timer-driven retries can still report
  // exhaustion even when no later turn drains this account.
  custody.warn = params.warn ?? custody.warn;
  for (const entry of params.messages) {
    custody.pending.push({ entry, attempts: 0 });
  }
  if (custody.pending.length > MAX_CUSTODY_ENTRIES_PER_ACCOUNT) {
    const dropped = custody.pending.splice(
      0,
      custody.pending.length - MAX_CUSTODY_ENTRIES_PER_ACCOUNT,
    );
    for (const record of dropped) {
      params.warn?.(
        `discord draft delete custody dropped (queue full): ` +
          `channel=${record.entry.channelId} message=${record.entry.messageId}`,
      );
    }
  }
  scheduleCustodyRetry(key, custody);
}

async function drainDiscordDraftDeleteCustodyByKey(
  key: string,
  warn?: (message: string) => void,
): Promise<void> {
  const custody = getCustodyByAccount().get(key);
  if (!custody) {
    return;
  }
  if (custody.drainInFlight) {
    // Drains are serialized per account: await the in-flight sweep so callers
    // observe its deletions instead of racing a second overlapping drain.
    await custody.drainInFlight;
    return;
  }
  if (!custody.pending.length) {
    return;
  }
  const effectiveWarn = warn ?? custody.warn;
  const inFlight = (async () => {
    const due = custody.pending;
    custody.pending = [];
    for (const record of due) {
      record.attempts += 1;
      try {
        await record.entry.remove();
      } catch (err) {
        if (record.attempts >= MAX_CUSTODY_DELETE_ATTEMPTS) {
          effectiveWarn?.(
            `discord draft delete custody exhausted: ` +
              `channel=${record.entry.channelId} message=${record.entry.messageId} ` +
              `(${formatErrorMessage(err)})`,
          );
          continue;
        }
        custody.pending.push(record);
      }
    }
  })();
  custody.drainInFlight = inFlight;
  try {
    await inFlight;
  } finally {
    custody.drainInFlight = undefined;
  }
  // Registry ownership is retained until every claimed record settles, so a
  // requeued failure still has its account entry and retry timer.
  if (!custody.pending.length) {
    clearCustodyRetryTimer(custody);
    getCustodyByAccount().delete(key);
    return;
  }
  scheduleCustodyRetry(key, custody);
}

/** Retry failed deletes adopted for this account. Safe to call at any boundary. */
export async function drainDiscordDraftDeleteCustody(
  accountId: string,
  warn?: (message: string) => void,
): Promise<void> {
  await drainDiscordDraftDeleteCustodyByKey(resolveAccountKey(accountId), warn);
}
